import assert from 'node:assert/strict';
import test from 'node:test';
import { createEpistemicGraphTransport } from '../src/epistemic-graph/transport.ts';

const schema = 'narada.operator_console.epistemic_graph.v1' as const;

test('epistemic graph transport uses the Site-bound same-origin endpoint and carries no browser identity', async () => {
  let seenInput: RequestInfo | URL | undefined;
  let seenInit: RequestInit | undefined;
  const fetchLike: typeof fetch = async (input, init) => {
    seenInput = input;
    seenInit = init;
    return new Response(JSON.stringify({
      schema,
      status: 'success',
      site_id: 'site/a',
      command: 'query',
      authority: { kind: 'site', site_id: 'site/a' },
      principal: { kind: 'operator', id: 'server-authenticated' },
      ledger_head: 'sha256:head',
      result: { status: 'ok' },
      error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await createEpistemicGraphTransport('site/a', fetchLike)
    .call('query', { kind: 'claim' }, 'sha256:before');

  assert.equal(seenInput, '/console/sites/site%2Fa/epistemic-graph/api');
  assert.equal(seenInit?.credentials, 'same-origin');
  const body = JSON.parse(String(seenInit?.body));
  assert.deepEqual(body, {
    schema,
    site_id: 'site/a',
    command: 'query',
    arguments: { kind: 'claim' },
    expected_ledger_head: 'sha256:before',
  });
  assert.equal('actor' in body, false);
  assert.equal('authority_basis' in body, false);
  assert.equal(result.ledger_head, 'sha256:head');
});

test('epistemic graph transport rejects cross-Site and refused authority responses', async () => {
  const mismatch: typeof fetch = async () => new Response(JSON.stringify({
    schema,
    status: 'success',
    site_id: 'other',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    createEpistemicGraphTransport('site-a', mismatch).call('status'),
    /epistemic_graph_authority_response_mismatch/,
  );

  const refused: typeof fetch = async () => new Response(JSON.stringify({
    schema,
    status: 'refused',
    site_id: 'site-a',
    error: { code: 'ledger_head_mismatch', message: 'The graph changed.' },
  }), { status: 409, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    createEpistemicGraphTransport('site-a', refused).call('proposal-admit'),
    /The graph changed\./,
  );
});
