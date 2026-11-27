import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layoutDiagram, overlaps } from '../clients/web/src/diagram-layout.js'

const nodes = (...ids: string[]) => ids.map(id => ({ id, label: id }))
const pathPoints = (path: string) => path.slice(2).split(' L ').map(point => point.split(' ').map(Number) as [number, number])

function assertInside(layout: ReturnType<typeof layoutDiagram>) {
  for (const box of [...layout.nodes, ...layout.edges.flatMap(edge => edge.labelBox ? [edge.labelBox] : [])]) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height)
  }
}

test('diagram layout puts every forward edge into a lower row and keeps given order on ties', () => {
  const layout = layoutDiagram({
    nodes: nodes('a', 'b', 'c', 'd'),
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }],
  })
  const y = Object.fromEntries(layout.nodes.map(node => [node.id, node.y]))
  const x = Object.fromEntries(layout.nodes.map(node => [node.id, node.x]))
  assert.ok(y.a! < y.b! && y.b === y.c && y.c! < y.d!)
  assert.ok(x.b! < x.c!)
  assert.ok(layout.edges.every(edge => !edge.back))
  assert.equal(layout.nodes.length, 4, 'placeholders are not drawn as nodes')
  assertInside(layout)
})

test('a long edge passes beside intermediate nodes instead of through them', () => {
  const layout = layoutDiagram({
    nodes: nodes('a', 'b', 'c'),
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c', label: '跳过' }],
  })
  const middle = layout.nodes.find(node => node.id === 'b')!
  const long = layout.edges.find(edge => edge.key === 'a>c')!
  const insideMiddle = pathPoints(long.path).filter(([px, py]) =>
    px > middle.x && px < middle.x + middle.width && py >= middle.y && py <= middle.y + middle.height)
  assert.deepEqual(insideMiddle, [])
  assert.ok(pathPoints(long.path).length > 2, 'the long edge bends through a placeholder')
  assertInside(layout)
})

test('labels in the same gap and on loops do not overlap', () => {
  const layout = layoutDiagram({
    nodes: nodes('a', 'b', 'c'),
    edges: [
      { from: 'a', to: 'b', label: '第一种情况' }, { from: 'a', to: 'c', label: '第二种情况' },
      { from: 'b', to: 'a', label: '回到开头' }, { from: 'c', to: 'a', label: '再试一次' },
    ],
  })
  const boxes = layout.edges.flatMap(edge => edge.labelBox ? [edge.labelBox] : [])
  assert.equal(boxes.length, 4)
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i]!, boxes[j]!), `${i} and ${j}`)
  assert.deepEqual(layout.edges.map(edge => edge.back), [false, false, true, true])
  assertInside(layout)
})

test('a loop leaves and enters through the gaps, never across a row of nodes, and long labels wrap', () => {
  const layout = layoutDiagram({
    nodes: [{ id: 'try', label: '尝试回忆这段材料的要点' }, { id: 'check', label: '核对' }, { id: 'side', label: '旁注' }],
    edges: [{ from: 'try', to: 'check' }, { from: 'try', to: 'side' }, { from: 'check', to: 'try', label: '没记住' }],
  })
  assert.deepEqual(layout.nodes.find(node => node.id === 'try')!.lines, ['尝试回忆这段材料', '的要点'])
  const loop = layout.edges.find(edge => edge.back)!
  const points = pathPoints(loop.path)
  for (let index = 1; index < points.length; index++) {
    const [x1, y1] = points[index - 1]!
    const [x2, y2] = points[index]!
    for (const node of layout.nodes) {
      const segment = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1) || 0.1, height: Math.abs(y2 - y1) || 0.1 }
      const inner = { x: node.x + 1, y: node.y + 1, width: node.width - 2, height: node.height - 2 }
      assert.ok(!overlaps(segment, inner), `segment ${index} crosses ${node.id}`)
    }
  }
  assertInside(layout)
})

type Point = [number, number]
const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const properlyIntersect = (a: Point, b: Point, c: Point, d: Point) =>
  cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0

test('rows are reordered to remove crossings that the given order would cause', () => {
  const layout = layoutDiagram({
    nodes: nodes('a', 'b', 'c', 'd', 'e', 'f'),
    edges: [{ from: 'a', to: 'f' }, { from: 'b', to: 'e' }, { from: 'c', to: 'd' }],
  })
  const segments = layout.edges.map(edge => pathPoints(edge.path) as [Point, Point])
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      assert.ok(!properlyIntersect(...segments[i]!, ...segments[j]!), `${layout.edges[i]!.key} crosses ${layout.edges[j]!.key}`)
    }
  }
})

test('a label stays on its own line when the gap has room', () => {
  const layout = layoutDiagram({
    nodes: nodes('a', 'b', 'c'),
    edges: [{ from: 'a', to: 'b', label: '第一种情况' }, { from: 'a', to: 'c', label: '第二种情况' }],
  })
  for (const edge of layout.edges) {
    const [start, end] = pathPoints(edge.path) as [Point, Point]
    const box = edge.labelBox!
    const center: Point = [box.x + box.width / 2, box.y + box.height / 2]
    assert.ok(Math.abs(cross(start, end, center)) / Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.5, edge.key)
  }
})

test('Latin labels break between words and get narrower label boxes', () => {
  const layout = layoutDiagram({
    nodes: [{ id: 'a', label: 'Spaced repetition' }, { id: 'b', label: '间隔重复' }],
    edges: [{ from: 'a', to: 'b', label: 'recall' }],
  })
  assert.deepEqual(layout.nodes.find(node => node.id === 'a')!.lines, ['Spaced', 'repetition'])
  const latin = layout.edges[0]!.labelBox!.width
  const cjk = layoutDiagram({ nodes: nodes('a', 'b'), edges: [{ from: 'a', to: 'b', label: '回忆回忆回忆' }] }).edges[0]!.labelBox!.width
  assert.ok(latin < cjk, `${latin} < ${cjk}`)
})

test('a word longer than a line breaks between letters, and mixed text keeps words whole', () => {
  const lines = (label: string) => layoutDiagram({ nodes: [{ id: 'a', label }, { id: 'b', label: 'b' }], edges: [{ from: 'a', to: 'b' }] })
    .nodes.find(node => node.id === 'a')!.lines
  assert.deepEqual(lines('Internationalization'), ['International', 'ization'])
  assert.deepEqual(lines('用 Anki 安排复习计划'), ['用 Anki 安排复', '习计划'])
})

test('layout uses the injected text measurer for wrapping and label boxes', () => {
  const graph = { nodes: nodes('a', 'b'), edges: [{ from: 'a', to: 'b', label: 'recall' }] }
  const wide = layoutDiagram(graph, text => text.length * 40)
  assert.equal(wide.edges[0]!.labelBox!.width, 6 * 40 + 8)
  assert.deepEqual(layoutDiagram({ nodes: [{ id: 'a', label: 'ab cd' }, { id: 'b', label: 'b' }], edges: [{ from: 'a', to: 'b' }] },
    text => text.length * 40).nodes[0]!.lines, ['ab', 'cd'])
})

test('a label avoids the straight runs of other edges when its own line has room elsewhere', () => {
  // The loop from "no" back to "try" runs horizontally through the gap where the "skip" label would sit at its midpoint.
  const layout = layoutDiagram({
    nodes: [{ id: 'q', label: '看题' }, { id: 'try', label: '尝试回忆' }, { id: 'check', label: '核对' },
      { id: 'no', label: '需要再练' }, { id: 'later', label: '安排下次' }],
    edges: [{ from: 'q', to: 'try' }, { from: 'try', to: 'check' }, { from: 'check', to: 'no' },
      { from: 'no', to: 'try', label: '再试' }, { from: 'q', to: 'later', label: '跳过' }],
  })
  const skip = layout.edges.find(edge => edge.key === 'q>later')!.labelBox!
  const loop = pathPoints(layout.edges.find(edge => edge.key === 'no>try')!.path)
  for (let index = 1; index < loop.length; index++) {
    const [[x1, y1], [x2, y2]] = [loop[index - 1]!, loop[index]!]
    if (x1 !== x2 && y1 !== y2) continue
    const run = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1) || 0.1, height: Math.abs(y2 - y1) || 0.1 }
    assert.ok(!overlaps(skip, run), `the skip label covers loop segment ${index}`)
  }
  assertInside(layout)
})
