import { describe, expect, test } from 'bun:test';
import {
  parseDeliverSettings,
  type RawDeliverSettings,
} from '../../pack/devflow/.shared/lib/deliver-settings.ts';

const defaults: RawDeliverSettings = {
  checkstyle_cmd: 'mvn -B -q checkstyle:check',
  local_verify_cmd: '',
  copilot_mode: 'request',
  copilot_request_cmd: 'gh pr edit {number} --repo {repo} --add-reviewer @copilot',
  copilot_confirm_cmd: 'gh api --hostname {host} repos/{path}/issues/{number}/events',
  copilot_logins: 'copilot-pull-request-reviewer,Copilot',
  poll_interval_sec: '60',
  copilot_wait_min: '30',
  ci_wait_min: '90',
  required_checks: 'build, test',
};

describe('parseDeliverSettings', () => {
  test('the pack defaults parse', () => {
    expect(parseDeliverSettings(defaults)).toMatchObject({
      copilotMode: 'request',
      copilotLogins: ['copilot-pull-request-reviewer', 'Copilot'],
      pollIntervalSec: 60,
      copilotWaitMin: 30,
      ciWaitMin: 90,
      requiredChecks: ['build', 'test'],
    });
  });
  test('each bad value names its setting', () => {
    expect(() => parseDeliverSettings({ ...defaults, copilot_mode: 'always' })).toThrow(
      'copilot_mode'
    );
    expect(() => parseDeliverSettings({ ...defaults, copilot_logins: '' })).toThrow(
      'copilot_logins'
    );
    expect(() => parseDeliverSettings({ ...defaults, copilot_request_cmd: ' ' })).toThrow(
      'copilot_request_cmd'
    );
    expect(() =>
      parseDeliverSettings({ ...defaults, copilot_request_cmd: 'gh pr edit {nmber}' })
    ).toThrow(/copilot_request_cmd: .*\{nmber\}/);
    expect(() =>
      parseDeliverSettings({ ...defaults, copilot_confirm_cmd: 'gh api repos/{owner}' })
    ).toThrow(/copilot_confirm_cmd: .*\{owner\}/);
    expect(() => parseDeliverSettings({ ...defaults, checkstyle_cmd: '' })).toThrow(
      'checkstyle_cmd'
    );
    expect(() => parseDeliverSettings({ ...defaults, ci_wait_min: '141' })).toThrow('at most 140');
    expect(() => parseDeliverSettings({ ...defaults, poll_interval_sec: '0' })).toThrow(
      'poll_interval_sec'
    );
  });
  test('off needs neither logins nor a request command', () => {
    expect(
      parseDeliverSettings({
        ...defaults,
        copilot_mode: 'off',
        copilot_logins: '',
        copilot_request_cmd: '',
        copilot_confirm_cmd: '{unknown}',
      }).copilotMode
    ).toBe('off');
  });
});
