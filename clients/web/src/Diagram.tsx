import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { diagramLines, type DiagramBlock } from '../../../src/contracts/conversation'
import { diagramMetrics, estimateTextWidth, layoutDiagram, type MeasureText } from './diagram-layout'

let measuringContext: CanvasRenderingContext2D | null | undefined

// Measures with the font the drawing inherits. Without a canvas the layout keeps its estimate.
function measureWithPageFont(element: Element | null): MeasureText {
  measuringContext ??= document.createElement('canvas').getContext('2d')
  const context = measuringContext
  if (!context || !element) return estimateTextWidth
  const family = getComputedStyle(element).fontFamily
  return (text, fontSize) => {
    context.font = `${fontSize}px ${family}`
    return context.measureText(text).width
  }
}

// Web fonts can finish loading after the first layout, which changes text widths.
function useFontsVersion() {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let active = true
    void document.fonts?.ready.then(() => { if (active) setVersion(value => value + 1) })
    return () => { active = false }
  }, [])
  return version
}

// Reports whether the element is narrower than its content. A hidden element reports false.
function useOverflow(contentWidth: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const check = () => setOverflowing(element.scrollWidth > element.clientWidth + 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(element)
    return () => observer.disconnect()
  }, [contentWidth])
  return [ref, overflowing] as const
}

// The drawing keeps its natural size and scrolls sideways when it is wider than the message, so labels stay legible.
// Only a drawing that actually scrolls becomes a focusable region. The relation list carries the same nodes and edges
// for narrow screens, enlarged text and screen readers.
export function Diagram({ block }: { block: DiagramBlock }) {
  const id = useId()
  const marker = 'diagram-arrow-' + id.replace(/[^A-Za-z0-9_-]/gu, '')
  const figure = useRef<HTMLElement>(null)
  const fonts = useFontsVersion()
  const [measure, setMeasure] = useState<MeasureText>(() => estimateTextWidth)
  useLayoutEffect(() => { setMeasure(() => measureWithPageFont(figure.current)) }, [fonts])
  const layout = useMemo(() => layoutDiagram(block, measure), [block, measure])
  const [scroller, overflowing] = useOverflow(layout.width)
  const lines = diagramLines(block)
  const { lineHeight, paddingY } = diagramMetrics
  const scrollable = overflowing
    ? { role: 'region', 'aria-label': block.title + '的图形，可横向滚动，内容同下方关系列表', tabIndex: 0 } : {}
  return <figure ref={figure} className="diagram" aria-labelledby={id}>
    <figcaption id={id}>{block.title}</figcaption>
    <div ref={scroller} className="diagram-scroll" {...scrollable}>
      <svg className="diagram-drawing" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height}
        aria-hidden="true" focusable="false">
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="diagram-arrowhead" />
          </marker>
        </defs>
        {layout.edges.map(edge => <path key={edge.key} d={edge.path} className="diagram-edge" markerEnd={`url(#${marker})`} />)}
        {layout.edges.map(edge => edge.label && edge.labelBox && <g key={edge.key}>
          <rect className="diagram-edge-label-bg" {...edge.labelBox} rx={4} />
          <text className="diagram-edge-label" x={edge.labelBox.x + edge.labelBox.width / 2} y={edge.labelBox.y + edge.labelBox.height / 2}
            textAnchor="middle" dominantBaseline="central">{edge.label}</text>
        </g>)}
        {layout.nodes.map(node => <g key={node.id}>
          <rect className="diagram-node" x={node.x} y={node.y} width={node.width} height={node.height} rx={6} />
          <text className="diagram-node-label" textAnchor="middle">
            {node.lines.map((line, index) => <tspan key={index} x={node.x + node.width / 2}
              y={node.y + paddingY + lineHeight * (index + 0.5) + (node.height - paddingY * 2 - node.lines.length * lineHeight) / 2}
              dominantBaseline="central">{line}</tspan>)}
          </text>
        </g>)}
      </svg>
    </div>
    <ul className="diagram-relations" aria-label="关系">
      {lines.map((line, index) => <li key={index}>{line}</li>)}
    </ul>
    {!block.citations?.length && <p className="structured-note">由 AI 整理，未核对来源</p>}
  </figure>
}
