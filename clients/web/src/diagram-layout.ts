import type { DiagramBlock } from '../../../src/contracts/conversation'

export const diagramMetrics = {
  nodeWidth: 136, lineHeight: 18, paddingY: 10, rankGap: 56, columnGap: 24, margin: 16, loop: 40, charsPerLine: 7,
} as const

export interface PlacedNode { id: string; lines: string[]; x: number; y: number; width: number; height: number }
export interface PlacedEdge { key: string; path: string; label?: string; labelX: number; labelY: number; back: boolean }
export interface DiagramLayout { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[] }

function wrap(label: string) {
  const characters = Array.from(label)
  const lines: string[] = []
  for (let index = 0; index < characters.length; index += diagramMetrics.charsPerLine) {
    lines.push(characters.slice(index, index + diagramMetrics.charsPerLine).join(''))
  }
  return lines
}

// Edges that close a cycle are found by depth-first search in node order and drawn as loops on the right.
function backEdges({ nodes, edges }: Pick<DiagramBlock, 'nodes' | 'edges'>) {
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

// Longest-path layering: every forward edge points to a lower row, and rows keep the order nodes were given in.
function ranks(block: Pick<DiagramBlock, 'nodes' | 'edges'>, back: Set<number>) {
  const rank = new Map(block.nodes.map(node => [node.id, 0]))
  const forward = block.edges.filter((_, index) => !back.has(index))
  const incoming = new Map(block.nodes.map(node => [node.id, 0]))
  for (const edge of forward) incoming.set(edge.to, incoming.get(edge.to)! + 1)
  const queue = block.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id)
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

export function layoutDiagram(block: Pick<DiagramBlock, 'nodes' | 'edges'>): DiagramLayout {
  const { nodeWidth, lineHeight, paddingY, rankGap, columnGap, margin, loop } = diagramMetrics
  const back = backEdges(block)
  const rank = ranks(block, back)
  const rows: { id: string; lines: string[] }[][] = []
  for (const node of block.nodes) (rows[rank.get(node.id)!] ??= []).push({ id: node.id, lines: wrap(node.label) })
  const rowWidth = (count: number) => count * nodeWidth + (count - 1) * columnGap
  const contentWidth = Math.max(...rows.map(row => rowWidth(row.length)))
  const width = contentWidth + margin * 2 + (back.size ? loop : 0)
  const placed = new Map<string, PlacedNode>()
  let y = margin
  for (const row of rows.filter(Boolean)) {
    const height = Math.max(...row.map(node => node.lines.length)) * lineHeight + paddingY * 2
    let x = margin + (contentWidth - rowWidth(row.length)) / 2
    for (const node of row) {
      placed.set(node.id, { ...node, x, y, width: nodeWidth, height })
      x += nodeWidth + columnGap
    }
    y += height + rankGap
  }
  const edges = block.edges.map((edge, index): PlacedEdge => {
    const from = placed.get(edge.from)!
    const to = placed.get(edge.to)!
    const key = edge.from + '>' + edge.to
    if (back.has(index)) {
      const startX = from.x + from.width
      const endX = to.x + to.width
      const startY = from.y + from.height / 2
      const endY = to.y + to.height / 2
      const bend = Math.max(startX, endX) + loop
      return { key, back: true, label: edge.label, labelX: bend, labelY: (startY + endY) / 2,
        path: `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}` }
    }
    const startX = from.x + from.width / 2
    const startY = from.y + from.height
    const endX = to.x + to.width / 2
    const endY = to.y
    return { key, back: false, label: edge.label, labelX: (startX + endX) / 2, labelY: (startY + endY) / 2,
      path: `M ${startX} ${startY} L ${endX} ${endY}` }
  })
  return { width, height: y - rankGap + margin, nodes: [...placed.values()], edges }
}
