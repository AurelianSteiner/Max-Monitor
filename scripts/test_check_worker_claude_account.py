import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('account_check', Path(__file__).with_name('check-worker-claude-account.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class AccountVerificationContract(unittest.TestCase):
    def test_working_keychain_does_not_turn_a_scope_denial_into_verified_identity(self):
        probe = {'workerCredentialReadStatus':0, 'credentialMatchesWorkerRecord':True,
                 'workerProfileStatus':403, 'profileRequiredScope':'user:profile'}
        self.assertEqual(check.classify(probe), ('blocked_provider_profile_scope', 3))

    def test_provider_email_is_not_worker_evidence_when_the_token_fingerprint_differs(self):
        probe = {'workerCredentialReadStatus':0, 'credentialMatchesWorkerRecord':False,
                 'workerProfileStatus':200, 'authenticatedWorkerEmail':'other@example.invalid'}
        self.assertEqual(check.classify(probe), ('worker_token_not_confirmed', 1))

    def test_success_requires_both_the_worker_token_and_an_actual_provider_email(self):
        probe = {'workerCredentialReadStatus':0, 'credentialMatchesWorkerRecord':True, 'workerProfileStatus':200}
        self.assertEqual(check.classify(probe), ('provider_email_not_verified', 1))
        probe['authenticatedWorkerEmail'] = 'worker@example.invalid'
        self.assertEqual(check.classify(probe), ('provider_email_verified', 0))

    def test_keychain_failure_never_accepts_a_leftover_provider_result(self):
        probe = {'workerCredentialReadStatus':-25293, 'credentialMatchesWorkerRecord':True,
                 'workerProfileStatus':200, 'authenticatedWorkerEmail':'stale@example.invalid'}
        self.assertEqual(check.classify(probe), ('keychain_access_failed', 1))


if __name__ == '__main__':
    unittest.main()
