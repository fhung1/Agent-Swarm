"""Manage local macOS or Linux desktop VMs with Tart on Apple silicon."""

import argparse
import contextlib
import fcntl
import ipaddress
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,62}$")
MARKER = ".quant-swarm-fleet.json"


class FleetError(Exception):
    pass


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + ".lock", "a+") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class Config:
    def __init__(self, path):
        self.path = Path(path).resolve()
        raw = json.loads(self.path.read_text())
        if not isinstance(raw, dict):
            raise FleetError("config must be a JSON object")
        allowed = {"provider", "guest_os", "template", "name_prefix", "count", "state_file"}
        unknown = set(raw) - allowed
        if unknown:
            raise FleetError("unknown config keys: %s" % ", ".join(sorted(unknown)))
        if raw.get("provider") != "tart":
            raise FleetError("provider must be tart")
        self.guest_os = raw.get("guest_os")
        if self.guest_os not in ("macos", "linux"):
            raise FleetError("guest_os must be macos or linux")
        self.template = self.name(raw.get("template"), "template")
        self.prefix = self.name(raw.get("name_prefix"), "name_prefix")
        self.count = raw.get("count")
        if type(self.count) is not int or not 1 <= self.count <= 100:
            raise FleetError("count must be an integer from 1 to 100")
        self.names = ["%s-%02d" % (self.prefix, n) for n in range(1, self.count + 1)]
        if any(not NAME.fullmatch(name) for name in self.names):
            raise FleetError("name_prefix is too long")
        if self.template in self.names:
            raise FleetError("template name collides with a clone name")
        state_value = raw.get("state_file", ".tart-fleet-state.json")
        if not isinstance(state_value, str) or not state_value:
            raise FleetError("state_file must be a non-empty path")
        state = Path(state_value).expanduser()
        self.state_file = state if state.is_absolute() else self.path.parent / state
        tart_home = Path(os.environ.get("TART_HOME", "~/.tart")).expanduser()
        self.tart_home = tart_home.resolve()

    @staticmethod
    def name(value, field):
        if not isinstance(value, str) or not NAME.fullmatch(value):
            raise FleetError("%s must be a simple Tart VM name" % field)
        return value

    def identity(self):
        return {
            "provider": "tart", "guest_os": self.guest_os,
            "template": self.template, "name_prefix": self.prefix,
            "count": self.count, "tart_home": str(self.tart_home),
        }


class TartFleet:
    def __init__(self, config):
        self.config = config
        self.binary = None

    def tart(self, *args, timeout=180):
        if self.binary is None:
            if platform.system() != "Darwin" or platform.machine() != "arm64":
                raise FleetError("Tart fleet requires an Apple silicon Mac")
            self.binary = shutil.which("tart")
            if self.binary is None:
                raise FleetError("tart is not installed; see https://tart.run/quick-start/")
        try:
            result = subprocess.run([self.binary, *args], text=True, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise FleetError("tart %s timed out" % " ".join(args)) from error
        if result.returncode:
            raise FleetError("tart %s: %s" % (" ".join(args), result.stderr.strip() or result.stdout.strip()))
        return result.stdout.strip()

    def inventory(self):
        rows = json.loads(self.tart("list", "--source", "local", "--format", "json"))
        if not isinstance(rows, list):
            raise FleetError("tart list returned invalid JSON")
        return {row["Name"]: row for row in rows if row.get("Source", "").lower() == "local"}

    def vm_info(self, name):
        info = json.loads(self.tart("get", name, "--format", "json"))
        if not isinstance(info, dict) or not isinstance(info.get("Running"), bool):
            raise FleetError("tart get returned invalid JSON for %s" % name)
        return info

    def vm_directory(self, name):
        return self.config.tart_home / "vms" / name

    def marker(self, name):
        path = self.vm_directory(name) / MARKER
        if not path.is_file():
            return None
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            return None
        return record.get("id") if isinstance(record, dict) else None

    def manifest(self):
        path = self.config.state_file
        if not path.exists():
            raise FleetError("fleet state does not exist; run create first")
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or data.get("schema") != 1 or data.get("config") != self.config.identity():
            raise FleetError("Tart fleet state does not match this config or TART_HOME")
        if not isinstance(data.get("vms"), dict) or set(data["vms"]) != set(self.config.names):
            raise FleetError("Tart fleet state has unexpected VM names")
        return data

    def template(self, inventory):
        if self.config.template not in inventory:
            raise FleetError("local Tart template %s does not exist" % self.config.template)
        info = self.vm_info(self.config.template)
        expected_os = "darwin" if self.config.guest_os == "macos" else "linux"
        if info.get("OS", "").lower() != expected_os:
            raise FleetError("template OS is %s; config requires %s" % (info.get("OS"), self.config.guest_os))
        if info["Running"] or info.get("State", "").lower() != "stopped":
            raise FleetError("Tart template must be stopped before cloning")
        return info

    def template_id(self):
        directory = self.vm_directory(self.config.template)
        if not directory.is_dir():
            raise FleetError("Tart template directory is missing: %s" % directory)
        stat = directory.stat()
        return "%s:%s" % (stat.st_dev, stat.st_ino)

    def create(self):
        inventory = self.inventory()
        self.template(inventory)
        if self.config.state_file.exists():
            data = self.manifest()
            if data.get("template_id") != self.template_id():
                raise FleetError("Tart template was replaced; refusing to clone")
        else:
            collisions = [name for name in self.config.names if name in inventory]
            if collisions:
                raise FleetError("Tart VM name already exists: %s" % ", ".join(collisions))
            data = {"schema": 1, "config": self.config.identity(),
                    "template_id": self.template_id(),
                    "vms": {name: {"id": None} for name in self.config.names}}
            save(self.config.state_file, data)
        for name in self.config.names:
            expected = data["vms"][name]["id"]
            actual = self.marker(name) if name in inventory else None
            if expected:
                if actual != expected or name not in inventory:
                    raise FleetError("Tart VM %s is missing or was replaced" % name)
                continue
            if name in inventory:
                raise FleetError("Tart VM %s exists without a recorded ID; inspect interrupted clone manually" % name)
            self.tart("clone", self.config.template, name, timeout=1800)
            if name not in self.inventory():
                raise FleetError("clone command returned but %s is missing" % name)
            vm_id = str(uuid.uuid4())
            marker_path = self.vm_directory(name) / MARKER
            save(marker_path, {"id": vm_id, "fleet_state": str(self.config.state_file)})
            data["vms"][name]["id"] = vm_id
            save(self.config.state_file, data)

    def verified(self, inventory=None):
        data = self.manifest()
        inventory = inventory if inventory is not None else self.inventory()
        for name in self.config.names:
            expected = data["vms"][name]["id"]
            if not expected:
                raise FleetError("Tart VM %s has not been provisioned" % name)
            if name not in inventory or self.marker(name) != expected:
                raise FleetError("Tart VM %s is missing or was replaced" % name)
        return inventory

    def start(self):
        inventory = self.verified()
        for name in self.config.names:
            info = inventory[name]
            if info["Running"]:
                continue
            if info.get("State", "").lower() not in ("stopped", "suspended"):
                raise FleetError("cannot start %s while it is %s" % (name, info.get("State")))
            log_path = self.config.state_file.parent / (name + ".tart.log")
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "ab") as log:
                subprocess.Popen([self.binary, "run", name], stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if self.vm_info(name)["Running"]:
                    break
                time.sleep(1)
            else:
                raise FleetError("Tart VM %s did not start; see %s" % (name, log_path))
            inventory = self.inventory()

    def stop(self):
        inventory = self.verified()
        for name in self.config.names:
            if inventory[name]["Running"] or inventory[name].get("State", "").lower() == "suspended":
                self.tart("stop", name, "--timeout", "90", timeout=105)
            inventory = self.inventory()

    def ip(self, name):
        try:
            address = self.tart("ip", name, timeout=10)
            parsed = ipaddress.ip_address(address)
            return [str(parsed)] if not parsed.is_loopback and not parsed.is_link_local else []
        except (FleetError, ValueError):
            return []

    def status(self):
        data = self.manifest()
        inventory = self.inventory()
        result = []
        for name in self.config.names:
            expected = data["vms"][name]["id"]
            if name not in inventory:
                state = "unprovisioned" if expected is None else "missing"
                result.append({"name": name, "state": state, "ips": []})
                continue
            if expected is None or self.marker(name) != expected:
                result.append({"name": name, "state": "identity mismatch", "ips": []})
                continue
            info = inventory[name]
            state = "running" if info["Running"] else info.get("State", "unknown").lower()
            result.append({"name": name, "state": state,
                           "ips": self.ip(name) if info["Running"] else []})
        return result

    def wait_for_ips(self, timeout=180):
        deadline = time.monotonic() + timeout
        while True:
            current = self.status()
            if all(row["state"] == "running" and row["ips"] for row in current):
                return current
            if time.monotonic() >= deadline:
                missing = [row["name"] for row in current if not row["ips"]]
                raise FleetError("timed out waiting for Tart guest IPs: %s" % ", ".join(missing))
            time.sleep(2)

    def destroy(self):
        data = self.manifest()
        inventory = self.inventory()
        for name in self.config.names:
            expected = data["vms"][name]["id"]
            if name not in inventory:
                if expected is not None:
                    data["vms"][name]["id"] = None
                    save(self.config.state_file, data)
                continue
            if expected is None or self.marker(name) != expected:
                raise FleetError("Tart VM %s has no matching recorded ID; inspect manually" % name)
            if inventory[name]["Running"] or inventory[name].get("State", "").lower() != "stopped":
                raise FleetError("stop all VMs before destroy; %s is %s" % (name, inventory[name].get("State")))
            self.tart("delete", name, timeout=180)
            data["vms"][name]["id"] = None
            save(self.config.state_file, data)
            inventory = self.inventory()
        self.config.state_file.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Manage a local Tart desktop VM fleet on Apple silicon")
    parser.add_argument("--config", required=True, help="path to Tart fleet JSON config")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("plan", "create", "start", "up", "status", "stop", "destroy"):
        sub = commands.add_parser(command)
        if command in ("start", "up"):
            sub.add_argument("--wait-ip", action="store_true")
        if command == "destroy":
            sub.add_argument("--yes", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = Config(args.config)
        if args.command == "plan":
            print(json.dumps({"host": "local Mac", "guest_os": config.guest_os,
                              "template": config.template, "names": config.names,
                              "state_file": str(config.state_file),
                              "tart_home": str(config.tart_home)}, indent=2))
            return 0
        with locked(config.state_file):
            fleet = TartFleet(config)
            if args.command == "create":
                fleet.create()
            elif args.command == "start":
                fleet.start()
                if args.wait_ip:
                    fleet.wait_for_ips()
            elif args.command == "up":
                fleet.create()
                fleet.start()
                if args.wait_ip:
                    fleet.wait_for_ips()
            elif args.command == "stop":
                fleet.stop()
            elif args.command == "destroy":
                if not args.yes:
                    raise FleetError("destroy removes cloned VM storage; pass --yes to confirm")
                fleet.destroy()
            elif args.command == "status":
                print(json.dumps(fleet.status(), indent=2))
        return 0
    except (FleetError, OSError, ValueError, KeyError) as error:
        print("tart-fleet: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
