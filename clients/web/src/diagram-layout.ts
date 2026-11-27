import type { DiagramBlock } from '../../../src/contracts/conversation'

export const diagramMetrics = {
  nodeWidth: 136, dummyWidth: 16, lineHeight: 18, paddingY: 10, rankGap: 56, columnGap: 24, margin: 16,
  loop: 32, loopStep: 12, channelStep: 6, charsPerLine: 7, nodeFontSize: 14, labelFontSize: 13, labelHeight: 22, labelGap: 4,
} as const

export interface Box { x: number; y: number; width: number; height: number }
export interface PlacedNode extends Box { id: string; lines: string[] }
export interface PlacedEdge { key: string; path: string; label?: string; labelBox?: Box; back: boolean }
export interface DiagramLayout { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[] }

type Graph = Pick<DiagramBlock, 'nodes' | 'edges'>
// A slot is a real node or a placeholder that a long edge passes through. Placeholders keep edges off nodes.
type Slot = { id: string; lines: string[] | null }
type Point = [number, number]

const m = diagramMetrics

// Returns the rendered width of text at a font size. The browser measures with the page font; tests and
// environments without a canvas use the estimate.
export type MeasureText = (text: string, fontSize: number) => number

// CJK and full-width characters take a full em. Latin letters, digits and punctuation take about 0.6 em.
const fullWidth = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u
export const estimateTextWidth: MeasureText = (text, em) =>
  Array.from(text).reduce((sum, character) => sum + (fullWidth.test(character) ? em : em * 0.6), 0)

// Latin words, numbers and their joining marks stay together. Every other character is its own token, so CJK text
// may break anywhere, as in ordinary Chinese typesetting.
const tokens = (label: string) => label.match(/[\p{Script=Latin}\p{N}'’._-]+|\s+|./gsu) ?? []

// Lines hold the width of `charsPerLine` full-width characters. A word longer than a whole line breaks between letters.
function wrap(label: string, measure: MeasureText) {
  const budget = m.charsPerLine * m.nodeFontSize
  const fits = (text: string) => measure(text, m.nodeFontSize) <= budget
  const lines: string[] = []
  let line = ''
  const flush = () => {
    if (line.trim()) lines.push(line.trim())
    line = ''
  }
  for (const token of tokens(label)) {
    if (fits(line + token)) line += token
    else if (/^\s+$/u.test(token)) flush()
    else if (fits(token)) { flush(); line = token }
    else {
      for (const character of Array.from(token)) {
        if (line.trim() && !fits(line + character)) flush()
        line += character
      }
    }
  }
  flush()
  return lines
}

export function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

// Edges that close a cycle are found by depth-first search in node order and routed around the right side.
function backEdges({ nodes, edges }: Graph) {
  const state = new Map<string, 'visiting' | 'done'>()
  const back = new Set<number>()
  function visit(id: string) {
    state.set(id, 'visiting')
    edges.forEach((edge, index) => {
      if (edge.from !== id) return
      const next = state.get(edge.to)
      if (next === 'visiting') back.add(index)
      else if (!next) visit(edge.to)
    })
    state.set(id, 'done')
  }
  for (const node of nodes) if (!state.has(node.id)) visit(node.id)
  return back
}

// Longest-path layering: every remaining edge points to a lower row.
function ranks({ nodes, edges }: Graph, back: Set<number>) {
  const rank = new Map(nodes.map(node => [node.id, 0]))
  const forward = edges.filter((_, index) => !back.has(index))
  const incoming = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of forward) incoming.set(edge.to, incoming.get(edge.to)! + 1)
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id)
  while (queue.length) {
    const id = queue.shift()!
    for (const edge of forward.filter(item => item.from === id)) {
      rank.set(edge.to, Math.max(rank.get(edge.to)!, rank.get(id)! + 1))
      incoming.set(edge.to, incoming.get(edge.to)! - 1)
      if (incoming.get(edge.to) === 0) queue.push(edge.to)
    }
  }
  return rank
}

function buildRows(graph: Graph, back: Set<number>, measure: MeasureText) {
  const rank = ranks(graph, back)
  const rows: Slot[][] = Array.from({ length: Math.max(...rank.values()) + 1 }, () => [])
  for (const node of graph.nodes) rows[rank.get(node.id)!]!.push({ id: node.id, lines: wrap(node.label, measure) })
  const chains = new Map<number, string[]>()
  graph.edges.forEach((edge, index) => {
    if (back.has(index)) return
    const chain = [edge.from]
    for (let row = rank.get(edge.from)! + 1; row < rank.get(edge.to)!; row++) {
      // Node IDs cannot contain ":", so placeholder IDs never collide with them.
      const id = `${index}:${row}`
      rows[row]!.push({ id, lines: null })
      chain.push(id)
    }
    chains.set(index, [...chain, edge.to])
  })
  return { rows, chains }
}

// Barycentre sweeps reduce crossings. The sort is stable, so ties keep the order the nodes were given in.
function orderRows(rows: Slot[][], chains: Map<number, string[]>) {
  const position = new Map<string, number>()
  rows.forEach(row => row.forEach((slot, index) => position.set(slot.id, index)))
  const above = new Map<string, string[]>()
  const below = new Map<string, string[]>()
  for (const chain of chains.values()) {
    for (let index = 1; index < chain.length; index++) {
      below.set(chain[index - 1]!, [...below.get(chain[index - 1]!) ?? [], chain[index]!])
      above.set(chain[index]!, [...above.get(chain[index]!) ?? [], chain[index - 1]!])
    }
  }
  function sortRow(row: Slot[], neighbours: Map<string, string[]>) {
    const key = new Map(row.map((slot, index) => {
      const linked = neighbours.get(slot.id)
      return [slot.id, linked?.length ? linked.reduce((sum, id) => sum + position.get(id)!, 0) / linked.length : index]
    }))
    row.sort((a, b) => key.get(a.id)! - key.get(b.id)!)
    row.forEach((slot, index) => position.set(slot.id, index))
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let row = 1; row < rows.length; row++) sortRow(rows[row]!, above)
    for (let row = rows.length - 2; row >= 0; row--) sortRow(rows[row]!, below)
  }
  transpose(rows, position, below)
}

// Counts crossing links between one row and the row below it.
function crossingsBelow(row: Slot[], position: Map<string, number>, below: Map<string, string[]>) {
  const links = row.flatMap(slot => (below.get(slot.id) ?? []).map(target => [position.get(slot.id)!, position.get(target)!] as const))
  let crossings = 0
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      if ((links[i]![0] - links[j]![0]) * (links[i]![1] - links[j]![1]) < 0) crossings++
    }
  }
  return crossings
}

// Barycentres can leave crossings that swapping two neighbours removes. Swaps happen only when they strictly help,
// so the given order survives whenever it is already as good.
function transpose(rows: Slot[][], position: Map<string, number>, below: Map<string, string[]>) {
  const cost = (index: number) => (index > 0 ? crossingsBelow(rows[index - 1]!, position, below) : 0)
    + (index < rows.length - 1 ? crossingsBelow(rows[index]!, position, below) : 0)
  for (let pass = 0, improved = true; improved && pass < 8; pass++) {
    improved = false
    rows.forEach((row, index) => {
      for (let slot = 0; slot < row.length - 1; slot++) {
        const before = cost(index)
        const swap = () => {
          [row[slot], row[slot + 1]] = [row[slot + 1]!, row[slot]!]
          position.set(row[slot]!.id, slot)
          position.set(row[slot + 1]!.id, slot + 1)
        }
        swap()
        if (cost(index) < before) improved = true
        else swap()
      }
    })
  }
}

function placeRows(rows: Slot[][], top: number) {
  const slotWidth = (slot: Slot) => slot.lines ? m.nodeWidth : m.dummyWidth
  const rowWidth = (row: Slot[]) => row.reduce((sum, slot) => sum + slotWidth(slot), 0) + (row.length - 1) * m.columnGap
  const contentWidth = Math.max(...rows.map(rowWidth))
  const placed = new Map<string, PlacedNode>()
  let y = top
  for (const row of rows) {
    const height = Math.max(1, ...row.map(slot => slot.lines?.length ?? 0)) * m.lineHeight + m.paddingY * 2
    let x = m.margin + (contentWidth - rowWidth(row)) / 2
    for (const slot of row) {
      placed.set(slot.id, { id: slot.id, lines: slot.lines ?? [], x, y, width: slotWidth(slot), height })
      x += slotWidth(slot) + m.columnGap
    }
    y += height + m.rankGap
  }
  return { placed, contentWidth, bottom: y - m.rankGap }
}

const pathOf = (points: Point[]) => 'M ' + points.map(point => point.join(' ')).join(' L ')
const centerX = (box: Box) => box.x + box.width / 2
const labelSize = (label: string, measure: MeasureText) =>
  ({ width: Math.ceil(measure(label, m.labelFontSize)) + 8, height: m.labelHeight })

function routeForward(chain: string[], placed: Map<string, PlacedNode>) {
  const start = placed.get(chain[0]!)!
  const end = placed.get(chain.at(-1)!)!
  const points: Point[] = [[centerX(start), start.y + start.height]]
  for (const id of chain.slice(1, -1)) {
    const slot = placed.get(id)!
    points.push([centerX(slot), slot.y], [centerX(slot), slot.y + slot.height])
  }
  points.push([centerX(end), end.y])
  return { path: pathOf(points), firstSegment: [points[0]!, points[1]!] as [Point, Point] }
}

const labelPositions = [0.5, 0.35, 0.65, 0.2, 0.8]

// Each forward label sits on the first segment of its edge. It tries a few points along that segment before
// sliding sideways, so a crowded gap keeps labels next to their own lines.
function placeForwardLabels(requests: { edge: PlacedEdge; segment: [Point, Point] }[], nodes: Box[], measure: MeasureText) {
  const taken: Box[] = []
  for (const { edge, segment: [[x1, y1], [x2, y2]] } of requests) {
    const size = labelSize(edge.label!, measure)
    const at = (t: number): Box => ({ ...size, x: x1 + (x2 - x1) * t - size.width / 2, y: y1 + (y2 - y1) * t - size.height / 2 })
    const clearOf = (obstacles: Box[]) => (box: Box) => !obstacles.some(other => overlaps(box, other))
    let box = labelPositions.map(at).find(clearOf([...taken, ...nodes]))
    if (!box) {
      box = at(0.5)
      while (!clearOf(taken)(box)) box.x += m.labelGap
    }
    taken.push(box)
    edge.labelBox = box
  }
}

// A back edge leaves through the channel below its source, climbs past the right edge and enters from the channel
// above its target, so it never runs across a row of nodes.
function routeBack(from: PlacedNode, to: PlacedNode, order: number, right: number, measure: MeasureText, label?: string) {
  const exitX = from.x + from.width * 0.75
  const entryX = to.x + to.width * 0.75
  const below = from.y + from.height + m.rankGap / 2 + order * m.channelStep
  const above = to.y - m.rankGap / 2 - order * m.channelStep
  const bend = right + m.loop + order * m.loopStep
  const points: Point[] = [[exitX, from.y + from.height], [exitX, below], [bend, below], [bend, above], [entryX, above], [entryX, to.y]]
  if (!label) return { path: pathOf(points) }
  const size = labelSize(label, measure)
  return { path: pathOf(points), labelBox: { ...size, x: bend + m.labelGap, y: (below + above) / 2 - size.height / 2 } }
}

// Pushes overlapping boxes apart along one axis, keeping their original order on that axis.
function separate(boxes: Box[], axis: 'x' | 'y') {
  const extent = axis === 'x' ? 'width' : 'height'
  const sorted = [...boxes].sort((a, b) => a[axis] - b[axis])
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!
    const current = sorted[index]!
    current[axis] = Math.max(current[axis], previous[axis] + previous[extent] + m.labelGap)
  }
}

export function layoutDiagram(graph: Graph, measure: MeasureText = estimateTextWidth): DiagramLayout {
  const back = backEdges(graph)
  const { rows, chains } = buildRows(graph, back, measure)
  orderRows(rows, chains)
  // Back edges need channels above the first row and below the last row.
  const channel = back.size ? m.rankGap / 2 + back.size * m.channelStep : 0
  const { placed, contentWidth, bottom } = placeRows(rows, m.margin + channel)
  const right = m.margin + contentWidth
  let backOrder = 0
  const requests: { edge: PlacedEdge; segment: [Point, Point] }[] = []
  const edges = graph.edges.map((edge, index): PlacedEdge => {
    const key = edge.from + '>' + edge.to
    if (back.has(index)) {
      const route = routeBack(placed.get(edge.from)!, placed.get(edge.to)!, backOrder++, right, measure, edge.label)
      return { key, back: true, label: edge.label, ...route }
    }
    const { path, firstSegment } = routeForward(chains.get(index)!, placed)
    const placedEdge: PlacedEdge = { key, back: false, label: edge.label, path }
    if (edge.label) requests.push({ edge: placedEdge, segment: firstSegment })
    return placedEdge
  })
  const nodes = [...placed.values()].filter(node => node.lines.length)
  placeForwardLabels(requests, nodes, measure)
  separate(edges.flatMap(edge => edge.back && edge.labelBox ? [edge.labelBox] : []), 'y')
  const boxes = edges.flatMap(edge => edge.labelBox ? [edge.labelBox] : [])
  const loops = back.size ? m.loop + (back.size - 1) * m.loopStep : 0
  const width = Math.max(right + loops + m.margin, ...boxes.map(box => box.x + box.width + m.margin))
  const height = Math.max(bottom + channel + m.margin, ...boxes.map(box => box.y + box.height + m.margin))
  return { width, height, nodes, edges }
}
