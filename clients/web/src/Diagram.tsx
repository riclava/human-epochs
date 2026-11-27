import { useId, useMemo } from 'react'
import { diagramLines, type DiagramBlock } from '../../../src/contracts/conversation'
import { diagramMetrics, layoutDiagram } from './diagram-layout'

const labelCharWidth = 13

// The drawing is decorative. The relation list beside it carries the same nodes and edges for narrow screens,
// enlarged text and screen readers.
export function Diagram({ block }: { block: DiagramBlock }) {
  const id = useId()
  const marker = 'diagram-arrow-' + id.replace(/[^A-Za-z0-9_-]/gu, '')
  const layout = useMemo(() => layoutDiagram(block), [block])
  const lines = diagramLines(block)
  const { lineHeight, paddingY } = diagramMetrics
  return <figure className="diagram" aria-labelledby={id}>
    <figcaption id={id}>{block.title}</figcaption>
    <svg className="diagram-drawing" viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ maxWidth: layout.width }}
      aria-hidden="true" focusable="false">
      <defs>
        <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="diagram-arrowhead" />
        </marker>
      </defs>
      {layout.edges.map(edge => <g key={edge.key}>
        <path d={edge.path} className="diagram-edge" markerEnd={`url(#${marker})`} />
        {edge.label && <>
          <rect className="diagram-edge-label-bg" x={edge.labelX - Array.from(edge.label).length * labelCharWidth / 2 - 4}
            y={edge.labelY - 11} width={Array.from(edge.label).length * labelCharWidth + 8} height={22} rx={4} />
          <text className="diagram-edge-label" x={edge.labelX} y={edge.labelY} textAnchor="middle" dominantBaseline="central">
            {edge.label}
          </text>
        </>}
      </g>)}
      {layout.nodes.map(node => <g key={node.id}>
        <rect className="diagram-node" x={node.x} y={node.y} width={node.width} height={node.height} rx={6} />
        <text className="diagram-node-label" x={node.x + node.width / 2} textAnchor="middle">
          {node.lines.map((line, index) => <tspan key={index} x={node.x + node.width / 2}
            y={node.y + paddingY + lineHeight * (index + 0.5) + (node.height - paddingY * 2 - node.lines.length * lineHeight) / 2}
            dominantBaseline="central">{line}</tspan>)}
        </text>
      </g>)}
    </svg>
    <ul className="diagram-relations" aria-label="关系">
      {lines.map((line, index) => <li key={index}>{line}</li>)}
    </ul>
  </figure>
}
