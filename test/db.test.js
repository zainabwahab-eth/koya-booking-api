import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { applyDnsServers, parseDnsServers } from '../src/db.js';

describe('DNS_SERVERS override', () => {
  const original = dns.getServers();
  after(() => dns.setServers(original));

  it('parses a comma-separated list, ignoring spaces and blanks', () => {
    assert.deepEqual(parseDnsServers('8.8.8.8, 1.1.1.1,,'), ['8.8.8.8', '1.1.1.1']);
    assert.deepEqual(parseDnsServers(''), []);
    assert.deepEqual(parseDnsServers(undefined), []);
  });

  it('leaves the system resolvers alone when unset', () => {
    const before = dns.getServers();
    assert.deepEqual(applyDnsServers(undefined), []);
    assert.deepEqual(dns.getServers(), before);
  });

  it('switches Node to the given resolvers when set', () => {
    applyDnsServers('8.8.8.8,1.1.1.1');
    assert.deepEqual(dns.getServers(), ['8.8.8.8', '1.1.1.1']);
  });
});
