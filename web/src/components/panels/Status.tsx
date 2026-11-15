export type StatusValue = { text: string; error?: boolean; ok?: boolean } | null;

export function Status({ value }: { value: StatusValue }) {
  if (!value?.text) return null;
  return (
    <p className={`status${value.error ? " error" : value.ok ? " ok" : ""}`} role="status">
      {value.text}
    </p>
  );
}
