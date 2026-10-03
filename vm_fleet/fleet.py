"""Manage isolated desktop VMs on a remote libvirt host over SSH."""

import argparse
import contextlib
import fcntl
import ipaddress
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path


NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,62}$")
TARGET = re.compile(r"^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+$")
URI = re.compile(r"^qemu:///system$")


class FleetError(Exception):
    pass


def _name(value, field):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise FleetError("%s must be a simple libvirt name" % field)
    return value


class Config:
    def __init__(self, path):
        self.path = Path(path).resolve()
        raw = json.loads(self.path.read_text())
        if not isinstance(raw, dict):
            raise FleetError("config must be a JSON object")
        allowed = {"ssh_target", "libvirt_uri", "template", "name_prefix", "count", "state_file"}
        unknown = set(raw) - allowed
        if unknown:
            raise FleetError("unknown config keys: %s" % ", ".join(sorted(unknown)))
        self.ssh_target = raw["ssh_target"]
        if not isinstance(self.ssh_target, str) or not TARGET.fullmatch(self.ssh_target) or self.ssh_target.startswith("-"):
            raise FleetError("ssh_target must be user@host or host")
        self.uri = raw.get("libvirt_uri", "qemu:///system")
        if not isinstance(self.uri, str) or not URI.fullmatch(self.uri):
            raise FleetError("only qemu:///system is supported")
        self.template = _name(raw["template"], "template")
        self.prefix = _name(raw["name_prefix"], "name_prefix")
        self.count = raw["count"]
        if type(self.count) is not int or not 1 <= self.count <= 100:
            raise FleetError("count must be an integer from 1 to 100")
        names = ["%s-%02d" % (self.prefix, n) for n in range(1, self.count + 1)]
        if any(not NAME.fullmatch(name) for name in names):
            raise FleetError("name_prefix is too long")
        if self.template in names:
            raise FleetError("template name collides with a clone name")
        self.names = names
        state_value = raw.get("state_file", ".vm-fleet-state.json")
        if not isinstance(state_value, str) or not state_value:
            raise FleetError("state_file must be a non-empty path")
        state = Path(state_value)
        self.state_file = state if state.is_absolute() else self.path.parent / state

    def identity(self):
        return {
            "ssh_target": self.ssh_target,
            "libvirt_uri": self.uri,
            "template": self.template,
            "name_prefix": self.prefix,
            "count": self.count,
        }


class SSHRunner:
    def __init__(self, config):
        self.config = config

    def run(self, args, check=True, timeout=180):
        remote = shlex.join(args)
        cmd = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", self.config.ssh_target, remote]
        result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if check and result.returncode:
            raise FleetError("remote command failed (%s): %s" % (shlex.join(args), result.stderr.strip()))
        return result


def _save(path, value):
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


def parse_ips(output):
    addresses = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 4 or parts[2] not in ("ipv4", "ipv6"):
            continue
        try:
            address = ipaddress.ip_interface(parts[3]).ip
        except ValueError:
            continue
        if not (address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast):
            addresses.append(str(address))
    return addresses


class Fleet:
    def __init__(self, config, runner=None):
        self.config = config
        self.runner = runner or SSHRunner(config)

    def virsh(self, *args, check=True):
        return self.runner.run(["virsh", "-c", self.config.uri] + list(args), check=check)

    def domain_uuid(self, name):
        result = self.virsh("domuuid", name, check=False)
        if result.returncode:
            return None
        return result.stdout.strip()

    def state(self, name):
        return self.virsh("domstate", name).stdout.strip().lower()

    def manifest(self):
        path = self.config.state_file
        if not path.exists():
            raise FleetError("fleet state does not exist; run create first")
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or not isinstance(data.get("domains"), dict):
            raise FleetError("fleet state file is malformed")
        if data.get("schema") != 1 or data.get("config") != self.config.identity():
            raise FleetError("fleet state does not match this config")
        if set(data.get("domains", {})) != set(self.config.names):
            raise FleetError("fleet state has unexpected domain names")
        return data

    def create(self):
        path = self.config.state_file
        if path.exists():
            data = self.manifest()
        else:
            template_uuid = self.domain_uuid(self.config.template)
            if not template_uuid:
                raise FleetError("template domain does not exist")
            if self.state(self.config.template) != "shut off":
                raise FleetError("template must be shut off before cloning")
            collisions = [name for name in self.config.names if self.domain_uuid(name)]
            if collisions:
                raise FleetError("domain name already exists: %s" % ", ".join(collisions))
            data = {
                "schema": 1,
                "config": self.config.identity(),
                "template_uuid": template_uuid,
                "domains": {name: {"uuid": None} for name in self.config.names},
            }
            _save(path, data)
        if self.domain_uuid(self.config.template) != data["template_uuid"]:
            raise FleetError("template UUID changed; refusing to clone")
        for name in self.config.names:
            expected = data["domains"][name]["uuid"]
            actual = self.domain_uuid(name)
            if expected:
                if actual != expected:
                    raise FleetError("domain %s is missing or was replaced" % name)
                continue
            if actual:
                raise FleetError("domain %s exists but has no recorded UUID; inspect interrupted clone manually" % name)
            self.runner.run([
                "virt-clone", "--connect", self.config.uri,
                "--original", self.config.template, "--name", name, "--auto-clone",
            ], timeout=1800)
            actual = self.domain_uuid(name)
            if not actual:
                raise FleetError("clone command returned but %s is missing" % name)
            data["domains"][name]["uuid"] = actual
            _save(path, data)
        return data

    def _verified(self):
        data = self.manifest()
        for name in self.config.names:
            expected = data["domains"][name]["uuid"]
            if not expected:
                raise FleetError("domain %s has not been provisioned" % name)
            if self.domain_uuid(name) != expected:
                raise FleetError("domain %s is missing or was replaced" % name)
        return data

    def start(self):
        self._verified()
        for name in self.config.names:
            state = self.state(name)
            if state == "shut off":
                self.virsh("start", name)
            elif state == "paused":
                self.virsh("resume", name)
            elif state != "running":
                raise FleetError("cannot start %s while it is %s" % (name, state))

    def stop(self, timeout=90):
        self._verified()
        for name in self.config.names:
            state = self.state(name)
            if state == "paused":
                self.virsh("resume", name)
                state = "running"
            if state in ("running", "blocked"):
                self.virsh("shutdown", name)
        deadline = time.monotonic() + timeout
        while True:
            active = [name for name in self.config.names if self.state(name) != "shut off"]
            if not active:
                return
            if time.monotonic() >= deadline:
                raise FleetError("graceful shutdown timed out: %s" % ", ".join(active))
            time.sleep(2)

    def status(self):
        data = self.manifest()
        result = []
        for name in self.config.names:
            expected = data["domains"][name]["uuid"]
            actual = self.domain_uuid(name)
            if expected is None and actual is None:
                result.append({"name": name, "state": "unprovisioned", "ips": []})
                continue
            if expected is not None and actual is None:
                result.append({"name": name, "state": "missing", "ips": []})
                continue
            if not expected or actual != expected:
                result.append({"name": name, "state": "identity mismatch", "ips": []})
                continue
            state = self.state(name)
            ips = []
            if state == "running":
                found = self.virsh("domifaddr", name, "--source", "agent", check=False)
                if found.returncode == 0:
                    ips = parse_ips(found.stdout)
            result.append({"name": name, "state": state, "ips": ips})
        return result

    def wait_for_ips(self, timeout=180):
        deadline = time.monotonic() + timeout
        while True:
            current = self.status()
            if all(item["state"] == "running" and item["ips"] for item in current):
                return current
            if time.monotonic() >= deadline:
                missing = [item["name"] for item in current if not item["ips"]]
                raise FleetError("timed out waiting for guest-agent IPs: %s" % ", ".join(missing))
            time.sleep(2)

    def destroy(self):
        data = self.manifest()
        for name in self.config.names:
            expected = data["domains"][name]["uuid"]
            actual = self.domain_uuid(name)
            if expected is None and actual is None:
                continue
            if expected is not None and actual is None:
                data["domains"][name]["uuid"] = None
                _save(self.config.state_file, data)
                continue
            if expected is None or actual != expected:
                raise FleetError("domain %s has no matching recorded UUID; inspect it manually" % name)
            state = self.state(name)
            if state != "shut off":
                raise FleetError("stop all VMs before destroy; %s is %s" % (name, state))
            self.virsh("undefine", name, "--remove-all-storage")
            data["domains"][name]["uuid"] = None
            _save(self.config.state_file, data)
        self.config.state_file.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Manage a game-neutral libvirt VM fleet over SSH")
    parser.add_argument("--config", required=True, help="path to fleet JSON config")
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
            print(json.dumps({"host": config.ssh_target, "template": config.template, "names": config.names, "state_file": str(config.state_file)}, indent=2))
            return 0
        with locked(config.state_file):
            fleet = Fleet(config)
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
    except (FleetError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print("vm-fleet: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
