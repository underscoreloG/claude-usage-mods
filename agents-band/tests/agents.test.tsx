import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

async function drain<C, R>(stream: AsyncGenerator<C, R> & { result: Promise<R> }): Promise<R> {
  for await (const _ of stream) {
    // read the stream to its end
  }
  return stream.result
}

test('shows a running subagent above what is beneath, then marks it done', async ($, on) => {
  const clock = mock.clock(on)
  on('agent.list', () => ({
    value: [{ id: 'a1', type: 'Explore', description: 'Inspect tests', status: 'running' as const }],
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model },
    }
  })
  on('tool.call', () => ({ result: 'ok' }))
  // stands in for usage-band, the mod beneath
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>USAGE ROW</Text>
  })

  await $.turn.start({ text: 'go', turnId: 's1', agentId: 'a1' })
  await drain($.turn.step({ turnId: 's1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' }))
  // agentId is reserved for the engine; a variable skips the literal's excess-property check
  const subagentCall = { tool: 'Grep' as const, pattern: 'x', tool_use_id: 'tu1', agentId: 'a1' }
  await $.tool.call(subagentCall)
  await clock.advance(3000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agents-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    const left = (await ui.find({ type: 'Text', text: /Explore/ }))?.text ?? ''
    expect(left).toContain('Inspect tests')
    const right = (await ui.find({ type: 'Text', text: /sonnet/ }))?.text ?? ''
    expect(right).toContain('1 tools')
    expect(right).toContain('1.2k tok')
    // both mods drawn, subagents first
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const agentsAt = texts.findIndex(t => /Explore/.test(t))
    const usageAt = texts.indexOf('USAGE ROW')
    expect(usageAt).toBeGreaterThan(agentsAt)
    await ui.unmount()
  }

  await $.turn.complete({ turnId: 's1', agentId: 'a1', reason: 'answer', answer: '', durationMs: 3000, isAborted: false })
  const ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /1 finished/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /done/ })).toBeDefined()
})

test('draws nothing of its own with no subagents, leaving the band beneath', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>USAGE ROW</Text>
  })
  const ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: 'USAGE ROW' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Subagents/ })).toBeUndefined()
})
