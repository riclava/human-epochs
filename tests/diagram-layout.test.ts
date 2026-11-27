import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diagramMetrics, layoutDiagram } from '../clients/web/src/diagram-layout.js'

const nodes = (...ids: string[]) => ids.map(id => ({ id, label: id }))

test('diagram layout puts every forward edge into a lower row and keeps given order within a row', () => {
  const layout = layoutDiagram({
    nodes: nodes('a', 'b', 'c', 'd'),
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
  })
  const y = Object.fromEntries(layout.nodes.map(node => [node.id, node.y]))
  const x = Object.fromEntries(layout.nodes.map(node => [node.id, node.x]))
  assert.ok(y.a! < y.b! && y.b === y.c && y.c! < y.d!)
  assert.ok(x.b! < x.c!)
  assert.ok(layout.edges.every(edge => !edge.back))
  assert.ok(layout.nodes.every(node => node.x >= 0 && node.x + node.width <= layout.width && node.y + node.height <= layout.height))
})

test('diagram layout draws cycle-closing edges as loops and wraps long labels', () => {
  const layout = layoutDiagram({
    nodes: [{ id: 'try', label: '尝试回忆这段材料的要点' }, { id: 'check', label: '核对' }],
    edges: [{ from: 'try', to: 'check' }, { from: 'check', to: 'try', label: '没记住' }],
  })
  assert.deepEqual(layout.edges.map(edge => edge.back), [false, true])
  const first = layout.nodes.find(node => node.id === 'try')!
  assert.deepEqual(first.lines, ['尝试回忆这段材', '料的要点'])
  assert.equal(layout.width, diagramMetrics.nodeWidth + diagramMetrics.margin * 2 + diagramMetrics.loop)
})
