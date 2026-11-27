import { useId } from 'react'
import type { CSSProperties } from 'react'
import { eventLogLines, type EventLogBlock } from '../../../src/contracts/conversation'

type Direction = 'forward' | 'backward' | 'self'

// One ordered list serves every view. A sequence view only changes its layout when the container is wide enough,
// so narrow screens, enlarged text and screen readers read the same events in the same order.
export function EventLog({ block }: { block: EventLogBlock }) {
  const id = useId()
  const lines = eventLogLines(block)
  const column = new Map(block.participants.map((participant, index) => [participant.id, index]))
  const columns = { '--event-columns': block.participants.length } as CSSProperties
  return <figure className="event-log" data-view={block.view} aria-labelledby={id}>
    <figcaption id={id}>{block.title}</figcaption>
    <div className="event-log-frame" style={columns}>
      {block.view === 'sequence' && <ul className="event-log-participants" aria-label="参与方">
        {block.participants.map(participant => <li key={participant.id}>{participant.label}</li>)}
      </ul>}
      <ol className="event-log-events">
        {block.events.map((event, index) => {
          const from = column.get(event.from) ?? 0
          const to = column.get(event.to ?? event.from) ?? from
          const direction: Direction = to > from ? 'forward' : to < from ? 'backward' : 'self'
          const start = Math.min(from, to)
          const span = Math.abs(to - from) + 1
          const place = { '--event-start': start + 1, '--event-span': span } as CSSProperties
          return <li key={event.id} data-direction={direction} style={place}>
            <span className="event-log-actors">{lines[index]!.actors}</span>
            <span className="event-log-text">{lines[index]!.text}</span>
          </li>
        })}
      </ol>
    </div>
    {!block.citations?.length && <p className="structured-note">由 AI 整理，未核对来源</p>}
  </figure>
}
