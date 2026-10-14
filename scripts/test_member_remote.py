import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

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

    def test_credentials_are_never_sent_to_plain_http_or_in_a_url(self):
        for url in ['http://hub.example.test','https://user:pass@hub.example.test','https://hub.example.test?token=secret','https://hub.example.test#secret']:
            with self.assertRaises(ValueError): client.ticket_request(url,'RSMACS01','personal-token','macbook-1','unused')


if __name__ == '__main__':
    unittest.main()
