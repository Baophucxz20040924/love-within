interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Only needed when the switch is not inside a <label> with visible text. */
  ariaLabel?: string;
}

/** On/off switch (native checkbox with role="switch", so keyboard and screen readers work as expected). */
export function Switch({ checked, onChange, disabled, ariaLabel }: Props) {
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        className="switch__input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track" aria-hidden="true" />
    </span>
  );
}
