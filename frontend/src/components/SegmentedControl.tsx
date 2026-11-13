import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import './interactions.css';

interface Option<T extends string> {
  value: T;
  label: string;
  /** Stable button ID, usable as aria-labelledby on an existing tabpanel. */
  id?: string;
  /** ID of an existing panel; only used in tab mode. No panels are generated. */
  panelId?: string;
}

interface Props<T extends string> {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Use radio for a single choice, group for pressed filters, tabs only with linked panels. */
  mode: 'tabs' | 'radio' | 'group';
  disabled?: boolean;
  id?: string;
}

export function SegmentedControl<T extends string>({
  value, options, onChange, ariaLabel, mode, disabled = false, id,
}: Props<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStop = selectedIndex < 0 ? 0 : selectedIndex;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey || options.length === 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % options.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + options.length) % options.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons.current[next]?.focus();
    onChange(options[next].value);
  }

  return (
    <div
      id={id}
      className="segmented"
      role={mode === 'tabs' ? 'tablist' : mode === 'radio' ? 'radiogroup' : 'group'}
      aria-label={ariaLabel}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => { buttons.current[index] = node; }}
          id={option.id}
          type="button"
          role={mode === 'tabs' ? 'tab' : mode === 'radio' ? 'radio' : undefined}
          aria-selected={mode === 'tabs' ? value === option.value : undefined}
          aria-checked={mode === 'radio' ? value === option.value : undefined}
          aria-pressed={mode === 'group' ? value === option.value : undefined}
          aria-controls={mode === 'tabs' ? option.panelId : undefined}
          disabled={disabled}
          tabIndex={mode === 'group' || index === tabStop ? 0 : -1}
          className={`segmented__item${value === option.value ? ' is-active' : ''}`}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
