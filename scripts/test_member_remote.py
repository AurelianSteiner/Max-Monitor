import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import io
import sys
import json
import os

spec = importlib.util.spec_from_file_location('member_remote', Path(__file__).with_name('member-remote.py'))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class MemberRemoteTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='team remote ')
        self.addCleanup(self.directory.cleanup)
        key = Path(self.directory.name)/'key'
        subprocess.run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
        pub = ' '.join(Path(str(key)+'.pub').read_text().split()[:2])
        self.ticket = {'schema':1,'teamId':'RSMACS01','hubHost':'hub.example.test','hubUser':'max-monitor-access','hubHostKey':pub,
                       'worker':{'workerId':'macbook-1','username':'worker','port':23000,'hostKey':pub},
                       'certificate':'ssh-ed25519-cert-v01@openssh.com AAAA'}

    def test_proxy_uses_only_the_personal_temporary_key_with_both_host_pins(self):
        args=client.connection_args(self.ticket,self.directory.name,'check')
        self.assertIn('IdentityAgent=none',args)
        self.assertIn('StrictHostKeyChecking=yes',args)
        self.assertIn('HostKeyAlias=max-monitor-macbook-1',args)
        proxy=next(v for v in args if v.startswith('ProxyCommand='))
        parsed=client.shlex.split(proxy[len('ProxyCommand='):])
        self.assertIn('max-monitor-access@hub.example.test',parsed)
        self.assertIn('127.0.0.1:23000',parsed)
        self.assertIn(str(Path(self.directory.name)/'member'),parsed)
        self.assertNotIn('root@hub.example.test',parsed)
        self.assertEqual(args[-1],'/usr/bin/id -un')

    def test_response_cannot_redirect_to_another_team_mac_user_or_port(self):
        self.assertEqual(client.validate_ticket(self.ticket,'RSMACS01','macbook-1'),self.ticket)
        for field,value in [('teamId','OTHER123'),('hubUser','root'),('hubHost','host;id')]:
            with self.assertRaises(ValueError): client.validate_ticket({**self.ticket,field:value},'RSMACS01','macbook-1')
        for field,value in [('workerId','macbook-2'),('username','-oProxyCommand=evil'),('username',None),('port',22),('port',True),('hostKey','ssh-ed25519 AAAA')]:
            with self.assertRaises(ValueError): client.validate_ticket({**self.ticket,'worker':{**self.ticket['worker'],field:value}},'RSMACS01','macbook-1')

    def test_worker_certificate_is_never_offered_to_the_hub_proxy(self):
        identity = Path(self.directory.name)/'key'
        args = client.connection_args(self.ticket, self.directory.name, 'check', identity_file=identity)
        proxy = client.shlex.split(next(v for v in args if v.startswith('ProxyCommand='))[len('ProxyCommand='):])
        self.assertEqual([v for v in proxy if v.startswith('CertificateFile=')], ['CertificateFile=none'])
        self.assertEqual([v for v in args if v.startswith('CertificateFile=')],
                         [f'CertificateFile="{Path(self.directory.name)/"member-cert.pub"}"'])
        for hop in [args, proxy]:
            self.assertIn('IdentitiesOnly=yes', hop)
            self.assertIn('IdentityAgent=none', hop)
            self.assertIn('StrictHostKeyChecking=yes', hop)
            self.assertEqual(hop[hop.index('-i')+1], str(identity))

    def test_credentials_are_never_sent_to_plain_http_or_in_a_url(self):
        for url in ['http://hub.example.test','https://user:pass@hub.example.test','https://hub.example.test?token=secret','https://hub.example.test#secret']:
            with self.assertRaises(ValueError): client.ticket_request(url,'RSMACS01','personal-token','macbook-1','unused')

    def test_approved_source_key_is_used_for_request_and_both_ssh_hops_without_copying_it(self):
        identity = Path(self.directory.name)/'key'
        original = identity.read_bytes()
        real_run = subprocess.run
        ssh_calls = []
        def run(args, **kwargs):
            if args[0] == '/usr/bin/ssh':
                ssh_calls.append(args)
                return subprocess.CompletedProcess(args, 0, stdout='worker\n', stderr='')
            return real_run(args, **kwargs)
        with patch.object(sys, 'argv', ['member-remote.py','check','macbook-1','--token-stdin','--identity-file',str(identity)]), \
             patch.object(sys, 'stdin', io.StringIO('personal-token\n')), \
             patch.object(client, 'ticket_request', return_value=self.ticket) as request, \
             patch.object(client.subprocess, 'run', side_effect=run), \
             patch.object(sys, 'stdout', io.StringIO()):
            self.assertEqual(client.main(), 0)
        self.assertEqual(request.call_args.args[4], self.ticket['hubHostKey'])
        args = ssh_calls[0]
        self.assertEqual(args[args.index('-i')+1], str(identity))
        proxy = client.shlex.split(next(v for v in args if v.startswith('ProxyCommand='))[len('ProxyCommand='):])
        self.assertEqual(proxy[proxy.index('-i')+1], str(identity))
        self.assertEqual(identity.read_bytes(), original)

    def test_public_ticket_uses_source_key_without_requesting_or_reading_a_token(self):
        identity = Path(self.directory.name)/'key'
        real_run = subprocess.run
        def run(args, **kwargs):
            if args[0] == '/usr/bin/ssh':
                return subprocess.CompletedProcess(args, 0, stdout='worker\n', stderr='')
            return real_run(args, **kwargs)
        with patch.object(sys, 'argv', ['member-remote.py','check','macbook-1','--ticket-stdin','--identity-file',str(identity)]), \
             patch.object(sys, 'stdin', io.StringIO(json.dumps(self.ticket)+'\n')), \
             patch.object(client, 'ticket_request') as request, \
             patch.object(client.getpass, 'getpass') as prompt, \
             patch.object(client.subprocess, 'run', side_effect=run), \
             patch.object(sys, 'stdout', io.StringIO()):
            self.assertEqual(client.main(), 0)
            request.assert_not_called()
            prompt.assert_not_called()

    def test_wrong_target_ticket_fails_before_any_ssh_process(self):
        with patch.object(sys, 'argv', ['member-remote.py','check','macbook-2','--ticket-stdin']), \
             patch.object(sys, 'stdin', io.StringIO(json.dumps(self.ticket)+'\n')), \
             patch.object(client.subprocess, 'run') as run:
            with self.assertRaises(ValueError): client.main()
            run.assert_not_called()

    def test_separate_ticket_descriptor_never_consumes_binary_stdin(self):
        identity=Path(self.directory.name)/'key'
        control,writer=os.pipe()
        os.write(writer,json.dumps(self.ticket).encode());os.close(writer)
        payload=b'\x00\xff\xfe'+bytes(range(256))*64
        incoming=io.TextIOWrapper(io.BytesIO(payload),encoding='ascii')
        observed=[]
        def call(args,**kwargs):
            observed.append(incoming.buffer.read())
            with self.assertRaises(OSError):os.fstat(control)
            return 0
        with patch.object(sys,'argv',['member-remote.py','connect','macbook-1','--ticket-fd',str(control),'--identity-file',str(identity),'--','cat']), \
             patch.object(sys,'stdin',incoming),patch.object(client.subprocess,'call',side_effect=call), \
             patch.object(client,'ticket_request') as request,patch.object(client.getpass,'getpass') as prompt:
            self.assertEqual(client.main(),0)
            request.assert_not_called();prompt.assert_not_called()
        self.assertEqual(observed,[payload])


if __name__ == '__main__':
    unittest.main()
