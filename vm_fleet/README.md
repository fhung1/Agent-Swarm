# VM fleet setup

`fleet.py` manages a named group of desktop VMs on a remote Linux host that uses libvirt. It connects to the host over SSH, clones a prepared libvirt template, and can start, stop, and report on the clones. The intended use is one isolated graphical game client per agent, as described in [the game-agent plan](../GAME_AGENT_IMPLEMENTATION_PLAN.md).

This tool manages VM lifecycle only. It does not install or configure the host, create the template, install a game, expose a desktop to an agent, or run the agent workers. It does not require a GPU, but it also does not provide GPU acceleration; check graphics performance with one guest before choosing a host or scaling up.

## Requirements

### VM host

Use a Linux host with:

- KVM/QEMU and libvirt system instances (`qemu:///system`).
- `virsh` and `virt-clone` available to the SSH account without an interactive sudo prompt. Access to the system libvirt socket is effectively administrative access; use a trusted account.
- A libvirt network with DHCP and guest connectivity. The default `default` NAT network is sufficient when guests only need outbound access. Use a bridge or another network if the operator needs direct inbound access to guests.
- Enough CPU, memory, storage, and graphics capacity for the template and the intended number of running guests. No fixed VM size is prescribed; measure one, two, five, then ten clients.
- QEMU Guest Agent installed and running in the guest, with a guest-agent channel configured in the VM definition, if you want `--wait-ip` or guest IPs in `status`.

On an Ubuntu or Debian host, a typical package starting point is:

```sh
sudo apt update
sudo apt install qemu-kvm libvirt-daemon-system libvirt-clients virtinst
```

Enable the host's libvirt service/socket using the distribution's service name, then check that the default network is active if you plan to use it:

```sh
virsh -c qemu:///system list --all
virsh -c qemu:///system net-list --all
```

If the `default` network exists but is inactive, an administrator can enable it with:

```sh
sudo virsh net-start default
sudo virsh net-autostart default
```

Add the SSH account to the distribution's libvirt group or grant equivalent socket access, then log in again and verify that `virsh -c qemu:///system list --all` works without `sudo`. Group names and service management vary by distribution.

### Controller

Run the manager from macOS or Linux with Python 3.8+, an SSH client, and network access to the host. The SSH key must work non-interactively because the manager uses `BatchMode=yes`. Connect once interactively first to verify the host key and add it to `known_hosts`.

For example, an SSH config entry can keep the target short and avoid placing host details in project commands:

```sshconfig
Host vm-host
    HostName 192.0.2.10
    User vmadmin
    IdentityFile ~/.ssh/quant-swarm-vm
    IdentitiesOnly yes
```

Check both SSH and libvirt access before running the manager:

```sh
ssh vm-host 'virsh -c qemu:///system list --all'
python3 --version
```

## Prepare the desktop template

Create and boot one VM manually with `virt-manager`, `virt-install`, or your existing libvirt workflow. In `virt-manager`, create a new VM from the guest OS installer ISO, allocate CPU, memory, and disk for one graphical client, connect its NIC to the chosen libvirt network (the `default` network for outbound-only NAT), and select a graphical console such as SPICE. Set a fixed guest display resolution for repeatable screenshots. Hardware acceleration and GPU passthrough need separate host-specific setup; the fleet manager does not configure them. Choose the guest OS, desktop, and graphics configuration based on the game and desktop adapter you plan to use.

Prepare the template as a reusable clean image:

1. Install and update the guest OS, desktop environment, graphics drivers, and any software that should be common to all clients.
2. Install and enable `qemu-guest-agent` inside the guest. Add the QEMU Guest Agent virtio channel to the libvirt VM definition. For example, on a systemd guest:

   ```sh
   sudo apt install qemu-guest-agent
   sudo systemctl enable --now qemu-guest-agent
   ```

   Confirm the agent channel is present in the domain XML and that the agent runs after boot. A guest agent is required for IP reporting; without it, the VM can still run, but `--wait-ip` will time out and `status` will show no IPs.
3. Confirm the guest obtains a unique reachable address from the selected network when cloned. Prepare the image for cloning so machine identity and any SSH host keys are unique per guest; if using cloud-init, clean its instance state before shutting down and verify the clone behavior.
4. Install a game client only if that is part of the common image. Configure separate player profiles and credentials per VM where the game requires them. Do not bake personal credentials, API keys, or shared account secrets into the template.
5. Test the desktop and graphics path by connecting to one VM's graphical console. The fleet manager does not provide a screenshot/input service or desktop streaming endpoint.
6. Shut the template down cleanly. The template must be named and in the `shut off` state before `create` or `up` can clone it.

For the first setup, make and run one clone, open its graphical console, verify desktop input and game performance, then shut it down. Increase guest count only after measuring host memory, CPU, graphics performance, and server tick rate. Tune per-VM resources from those measurements; this repo does not define a VM size or promise that one host can run ten clients.

Check the template with:

```sh
ssh vm-host 'virsh -c qemu:///system domstate qs-desktop-template'
ssh vm-host 'virsh -c qemu:///system domuuid qs-desktop-template'
```

The template UUID is recorded in the local fleet state file. Replacing the template with a different VM under the same name causes the manager to stop rather than silently cloning from the replacement.

## Configure and inspect a fleet

From the repository root, make a private working copy of the example config and edit it:

```sh
cp vm_fleet/config.example.json vm_fleet/config.json
```

Example:

```json
{
  "ssh_target": "vm-host",
  "libvirt_uri": "qemu:///system",
  "template": "qs-desktop-template",
  "name_prefix": "qs-agent",
  "count": 2,
  "state_file": ".vm-fleet-state.json"
}
```

`ssh_target` is a host or `user@host` accepted by SSH. `libvirt_uri` must be `qemu:///system`. The manager names clones `<name_prefix>-01` through `<name_prefix>-<count>`; `count` must be from 1 to 100. The state file is resolved relative to the config file when its path is relative. It records the config identity, template UUID, and clone UUIDs so the manager can detect missing or replaced VMs. Keep the state file with the config and out of source control; do not delete or edit it while the managed clones exist.

Use `plan` to validate the config and see the exact VM names. This command does not connect to the host or change anything:

```sh
python3 vm_fleet/fleet.py --config vm_fleet/config.json plan
```

## VM task commands

Run these from the repository root. Commands other than `plan` take an exclusive local lock for the configured state file.

```sh
# Clone the template and start all guests
python3 vm_fleet/fleet.py --config vm_fleet/config.json up --wait-ip

# Inspect state and guest-agent IPs
python3 vm_fleet/fleet.py --config vm_fleet/config.json status

# Start already-created guests
python3 vm_fleet/fleet.py --config vm_fleet/config.json start --wait-ip

# Request graceful guest shutdown
python3 vm_fleet/fleet.py --config vm_fleet/config.json stop

# After guests are stopped, permanently remove clone definitions and disks
python3 vm_fleet/fleet.py --config vm_fleet/config.json destroy --yes
```

`create` clones without starting. `up` is equivalent to `create` followed by `start`. `start` and `up` accept `--wait-ip`; this waits up to three minutes for every guest to be running and report at least one address through QEMU Guest Agent. `stop` asks each guest to shut down and waits up to 90 seconds; it does not force power off a guest that fails to stop. `destroy --yes` removes each managed clone's storage with `virsh undefine --remove-all-storage`, then removes the state file. It never removes the template. Review the selected config and status before destroying; clone disks are deleted permanently.

The manager does not resize, suspend, or force-stop VMs. Open each graphical console using the host's libvirt tools or your desktop access solution. Use `status` to confirm guests are running and to obtain IP addresses for a separate desktop adapter or management tool.

## Configuration changes and recovery

The saved state is tied to `ssh_target`, URI, template name, name prefix, and count. Changing any of these while a state file exists is rejected. To change fleet size or names, either stop and destroy the managed fleet first (which deletes its disks), or use a new prefix and a separate config/state file so the existing fleet remains tracked.

The manager saves each clone's UUID after cloning it. If it is interrupted after libvirt creates a clone but before the UUID is saved, the next `create`/`up` stops with an “exists but has no recorded UUID” error. Inspect the VM on the host before resolving this: remove the incomplete clone manually only if it is safe to do so, then rerun `up`. Do not edit the state file to guess a UUID.

Other common cases:

- **SSH fails or prompts for a password:** confirm the SSH target, key, host-key entry, and non-interactive libvirt access. The manager will not prompt for passwords or sudo.
- **Template not found or running:** check the exact libvirt domain name and shut the template down cleanly.
- **`--wait-ip` times out:** check guest networking, DHCP, the guest-agent service and channel, then run `status`. A running guest with no reported IP can still be reached through its graphical console.
- **Guest appears missing or identity-mismatched:** stop and inspect the libvirt domain and local state file. The UUID checks are intentional safeguards against operating on a VM that replaced a managed clone.
- **Graceful stop times out:** use the guest console to diagnose shutdown. Once it is actually shut off, rerun `stop` or inspect with `status`; the manager does not issue a hard stop.

## Current limits

- Only the remote `qemu:///system` libvirt URI is supported.
- VM creation uses `virt-clone --auto-clone` from a shut-off template; the tool does not build images or inject per-VM provisioning data.
- VM sizing, GPU passthrough, network/firewall setup, graphical console access, game licensing, and per-agent desktop/input isolation are operator responsibilities.
- The tool reports guest IPs from QEMU Guest Agent but does not connect to those IPs or provide remote desktop access.
- This is infrastructure for the later game-agent application. It is separate from the current SpacetimeDB worker demo and does not launch that worker or any game agents.
