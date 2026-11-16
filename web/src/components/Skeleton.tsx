/** Placeholder rows shown while a list loads, shaped like the rows that will replace them. */
export function ListSkeleton({ rows = 3, avatar = true, label = "Завантаження" }: { rows?: number; avatar?: boolean; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          {avatar && <span className="skeleton-circle" />}
          <span className="skeleton-lines">
            <span className="skeleton-block" style={{ width: `${30 + ((i * 17) % 25)}%`, height: 14 }} />
            <span className="skeleton-block" style={{ width: `${50 + ((i * 23) % 30)}%`, height: 12 }} />
          </span>
        </div>
      ))}
    </div>
  );
}
