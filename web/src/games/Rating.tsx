/** A player's rating in this kind of game, next to their name; nothing while they have none. */
export function Rating({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  return (
    <span className="rating" title="Рейтинг у цій грі">
      {value}
    </span>
  );
}
