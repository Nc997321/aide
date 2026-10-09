/**
 * 用例总注册（TestAbility.onCreate 经此文件拉起全部套件）。
 */
import attemptTest from './Attempt.test';
import assemblerTest from './LinkAssembler.test';
import backoffTest from './Backoff.test';

export default function testsuite(): void {
  backoffTest();
  assemblerTest();
  attemptTest();
}
