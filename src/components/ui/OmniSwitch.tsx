type OmniSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
};

export default function OmniSwitch({ checked, onChange, ariaLabel, disabled = false, className }: OmniSwitchProps) {
  return (
    <span className={`omni-switch${className ? ` ${className}` : ""}`} data-checked={checked ? "true" : "false"}>
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="omni-switch__input"
      />
      <span className="omni-switch__track" aria-hidden="true">
        <span className="omni-switch__thumb" />
      </span>
    </span>
  );
}
