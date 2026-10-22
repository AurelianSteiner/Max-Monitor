#!/usr/bin/env python3
"""Use a personal Max Monitor team token for an ephemeral SSH connection."""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_key(value):
    if not isinstance(value, str) or len(value) > 512 or not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/]+={0,2}", value):
        raise ValueError("Ungültiger SSH-Hostschlüssel")
    wire = base64.b64decode(value.split()[1], validate=True)
    if len(wire) != 51 or wire[:15] != b"\x00\x00\x00\x0bssh-ed25519" or wire[15:19] != b"\x00\x00\x00\x20":
        raise ValueError("Ungültiger SSH-Hostschlüssel")
    return value


def validate_ticket(ticket, team_id, worker_id):
    if ticket.get("schema") != 1 or ticket.get("teamId") != team_id or not isinstance(ticket.get("worker"), dict):
        raise ValueError("Fernzugriff passt nicht zum Team")
    worker = ticket["worker"]
    if worker.get("workerId") != worker_id or not isinstance(worker.get("username"), str) or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", worker["username"], re.I):
        raise ValueError("Fernzugriff passt nicht zum Mac")
    if type(worker.get("port")) is not int or not 23000 <= worker["port"] <= 23999:
        raise ValueError("Ungültiger Wartungsport")
    if ticket.get("hubUser") != "max-monitor-access" or not isinstance(ticket.get("hubHost"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", ticket["hubHost"], re.I):
        raise ValueError("Ungültiger Wartungshub")
    public_key(ticket.get("hubHostKey"))
    public_key(worker.get("hostKey"))
    if not isinstance(ticket.get("certificate"), str) or len(ticket["certificate"]) > 16384 or not re.fullmatch(r"ssh-ed25519-cert-v01@openssh\.com [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?", ticket["certificate"]):
        raise ValueError("Ungültiges SSH-Zertifikat")
    return ticket


def connection_args(ticket, directory, mode, command=None, identity_file=None):
    root = Path(directory)
    common = ["-F", "/dev/null", "-i", str(identity_file or root / "member"), "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
              "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=30", "-o", "PermitLocalCommand=no",
              "-o", f'UserKnownHostsFile="{root / "known_hosts"}"', "-o", f'CertificateFile="{root / "member-cert.pub"}"',
              "-o", "ControlMaster=no", "-o", "ControlPath=none"]
    proxy = ["/usr/bin/ssh", *common, "-o", "HostKeyAlias=max-monitor-team-hub", "-W", f'127.0.0.1:{ticket["worker"]["port"]}',
             f'{ticket["hubUser"]}@{ticket["hubHost"]}']
    args = ["/usr/bin/ssh", *common, "-o", f'HostKeyAlias=max-monitor-{ticket["worker"]["workerId"]}', "-o", "ProxyCommand=" + shlex.join(proxy)]
    if mode == "check":
        args += ["-T"]
    elif not command:
        args += ["-t"]
    args += [f'{ticket["worker"]["username"]}@127.0.0.1']
    return args + (["/usr/bin/id -un"] if mode == "check" else command or [])


def ticket_request(server_url, team_id, token, worker_id, key):
    parsed = urllib.parse.urlsplit(server_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Eine HTTPS-Max-Monitor-Adresse ohne Zugangsdaten ist erforderlich")
    if not isinstance(token, str) or not token or len(token) > 512 or re.search(r"[\r\n\x00]", token):
        raise ValueError("Ungültiger Max-Monitor-Zugangscode")
    request = urllib.request.Request(server_url.rstrip("/") + f"/v1/teams/{team_id}/remote-access/certificate",
                                     data=json.dumps({"workerId": worker_id, "publicKey": key}).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError("Ungültige Fernzugriffs-Antwort")
            return validate_ticket(json.loads(raw), team_id, worker_id)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise ValueError("Max-Monitor-Zugangscode ungültig oder Zugang entfernt") from None
        raise ValueError(f"Fernzugriff konnte nicht freigegeben werden (HTTP {error.code})") from None


def main():
    parser = argparse.ArgumentParser(description="Terminal-Zugriff mit deinem persönlichen Max-Monitor-Zugang")
    parser.add_argument("mode", choices=["check", "connect"])
    parser.add_argument("worker_id")
    parser.add_argument("--server-url", default="https://api.ruegamer-steiner.de/max-monitor")
    parser.add_argument("--team-id", default="RSMACS01")
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument("--token-stdin", action="store_true", help="Geschützten Zugangscode aus stdin lesen")
    credentials.add_argument("--ticket-stdin", action="store_true", help="Öffentliches, bereits signiertes Max-Monitor-Ticket aus stdin lesen")
    parser.add_argument("--identity-file", help="Auf diesem Quell-Mac freigegebener privater Ed25519-Schlüssel")
    args, command = parser.parse_known_args()
    if command and command[0] == "--":
        command = command[1:]
    elif command:
        parser.error("Fernbefehle ausdrücklich nach -- angeben")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", args.worker_id) or not re.fullmatch(r"[A-Z0-9]{4,16}", args.team_id):
        raise ValueError("Ungültige Mac- oder Team-Kennung")
    supplied_ticket = None
    token = None
    if args.ticket_stdin:
        raw = sys.stdin.readline(65538)
        if len(raw.encode()) > 65536:
            raise ValueError("SSH-Ticket zu groß")
        supplied_ticket = validate_ticket(json.loads(raw), args.team_id, args.worker_id)
    else:
        token = sys.stdin.readline(514).strip() if args.token_stdin else getpass.getpass("Persönlicher Max-Monitor-Zugangscode: ")
    with tempfile.TemporaryDirectory(prefix="max-monitor-remote-") as directory:
        root = Path(directory)
        os.chmod(root, 0o700)
        identity_file = Path(args.identity_file).expanduser() if args.identity_file else Path.home() / ".ssh/max_monitor_remote_ed25519"
        if args.identity_file or identity_file.exists():
            if identity_file.is_symlink() or not identity_file.is_file() or identity_file.stat().st_mode & 0o077:
                raise ValueError("Der private Quell-Mac-Schlüssel muss eine geschützte reguläre Datei sein")
            key = public_key(" ".join(subprocess.run(["/usr/bin/ssh-keygen", "-y", "-f", str(identity_file)], check=True,
                             capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout.split()[:2]))
        else:
            if supplied_ticket is not None:
                raise ValueError("Der freigegebene Quell-Mac-Schlüssel fehlt")
            identity_file = root / "member"
            subprocess.run(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(identity_file)], check=True, capture_output=True)
            key = (root / "member.pub").read_text().strip()
        ticket = supplied_ticket or ticket_request(args.server_url, args.team_id, token, args.worker_id, key)
        token = None
        (root / "member-cert.pub").write_text(ticket["certificate"] + "\n")
        (root / "known_hosts").write_text("max-monitor-team-hub " + ticket["hubHostKey"] + "\nmax-monitor-" + args.worker_id + " " + ticket["worker"]["hostKey"] + "\n")
        for file in [root / "member-cert.pub", root / "known_hosts"]:
            os.chmod(file, 0o600)
        if args.mode == "check":
            result = subprocess.run(connection_args(ticket, root, "check", identity_file=identity_file), capture_output=True, text=True, timeout=60)
            if result.returncode or result.stdout.strip() != ticket["worker"]["username"]:
                raise ValueError("SSH-Verbindung zum erwarteten Mac-Benutzer konnte nicht bestätigt werden")
            print(json.dumps({"workerId": args.worker_id, "username": ticket["worker"]["username"], "verified": True}))
            return 0
        ssh_args = connection_args(ticket, root, "connect", command, identity_file=identity_file)
        if args.ticket_stdin and not command:
            with open('/dev/tty', 'rb') as terminal:
                return subprocess.call(ssh_args, stdin=terminal)
        return subprocess.call(ssh_args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError, urllib.error.URLError):
        # Errors may contain upstream bodies or URLs: never echo those credentials.
        print("Max Monitor: Fernzugriff fehlgeschlagen. Zugangscode und Mac-Kennung prüfen.", file=sys.stderr)
        sys.exit(1)
