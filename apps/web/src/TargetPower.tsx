import { useId, useState } from "react";

function isWattage(text: string) {
  const watts = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(watts) && watts > 0;
}

export function TargetPower({
  value,
  onChange,
}: {
  value: number;
  onChange: (watts: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const hint = useId();
  const valid = isWattage(draft);

  return (
    <div className="target-power">
      <label>
        Target power (W)
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : hint}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            if (isWattage(text)) onChange(Number(text));
          }}
          onBlur={() => setDraft(String(value))}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      {!valid && (
        <small id={hint}>
          Enter a positive whole number. Current estimate uses {value} W.
        </small>
      )}
    </div>
  );
}
