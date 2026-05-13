import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { HTMLInputTypeAttribute, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

export type PromptField = {
  label: string;
  defaultValue?: string;
  placeholder?: string;
  type?: HTMLInputTypeAttribute;
  required?: boolean;
  autoFocus?: boolean;
};

export type PromptDialogOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  fields: [PromptField] | [PromptField, PromptField];
};

type PromptDialogContextValue = {
  openPrompt: (options: PromptDialogOptions) => Promise<string[] | null>;
};

type PromptDialogState = {
  options: PromptDialogOptions;
  values: string[];
};

const PromptDialogContext = createContext<PromptDialogContextValue | null>(null);

export function usePromptDialog() {
  const context = useContext(PromptDialogContext);
  if (!context) {
    throw new Error("usePromptDialog must be used within PromptDialogProvider");
  }
  return context;
}

export function PromptDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<PromptDialogState | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const resolveRef = useRef<((value: string[] | null) => void) | null>(null);

  const closePrompt = useCallback((result: string[] | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setRequest(null);
    setValidationMessage(null);
    inputRefs.current = [];
    resolve?.(result);
  }, []);

  const openPrompt = useCallback((options: PromptDialogOptions) => {
    return new Promise<string[] | null>((resolve) => {
      if (resolveRef.current) {
        resolveRef.current(null);
      }
      resolveRef.current = resolve;
      setRequest({
        options,
        values: options.fields.map((field) => field.defaultValue ?? ""),
      });
      setValidationMessage(null);
    });
  }, []);

  useEffect(() => {
    return () => {
      resolveRef.current?.(null);
      resolveRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!request) {
      return;
    }

    const focusIndex = request.options.fields.findIndex((field) => field.autoFocus);
    const targetIndex = focusIndex >= 0 ? focusIndex : 0;
    const timer = window.setTimeout(() => {
      const input = inputRefs.current[targetIndex];
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [request]);

  const handleConfirm = useCallback(() => {
    if (!request) {
      return;
    }

    const nextValues = request.values.map((value) => value.trim());
    const invalidIndex = request.options.fields.findIndex((field, index) => (field.required ?? true) && !nextValues[index]);
    if (invalidIndex >= 0) {
      const invalidField = request.options.fields[invalidIndex];
      setValidationMessage(`${invalidField.label}不能为空`);
      const input = inputRefs.current[invalidIndex];
      if (input) {
        input.focus();
        input.select();
      }
      return;
    }

    closePrompt(nextValues);
  }, [closePrompt, request]);

  const handleCancel = useCallback(() => {
    closePrompt(null);
  }, [closePrompt]);

  const handleFieldChange = useCallback((index: number, value: string) => {
    setRequest((current) => {
      if (!current) {
        return current;
      }
      const nextValues = [...current.values];
      nextValues[index] = value;
      return {
        ...current,
        values: nextValues,
      };
    });
    setValidationMessage(null);
  }, []);

  const contextValue = useMemo<PromptDialogContextValue>(() => ({ openPrompt }), [openPrompt]);
  const portalTarget = typeof document === "undefined" ? null : document.body;

  const promptDialog = request ? (
    <div className="omni-confirm-overlay" onMouseDown={handleCancel}>
      <div
        className="omni-confirm-dialog omni-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="omni-prompt-dialog-title"
        aria-describedby={request.options.description ? "omni-prompt-dialog-description" : undefined}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            handleCancel();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            handleConfirm();
          }
        }}
      >
        <div className="omni-prompt-dialog__header">
          <div className="omni-confirm-dialog__title" id="omni-prompt-dialog-title">
            {request.options.title}
          </div>
          {request.options.description ? (
            <div className="omni-confirm-dialog__message" id="omni-prompt-dialog-description">
              {request.options.description}
            </div>
          ) : null}
        </div>

        <div className="omni-prompt-dialog__body">
          {request.options.fields.map((field, index) => {
            const inputId = `omni-prompt-dialog-field-${index}`;
            const isRequired = field.required ?? true;
            return (
              <label key={`${field.label}-${index}`} className="omni-prompt-dialog__field" htmlFor={inputId}>
                <span className="omni-prompt-dialog__field-label">
                  <span>{field.label}</span>
                  {!isRequired ? <small>可选</small> : null}
                </span>
                <input
                  ref={(element) => {
                    inputRefs.current[index] = element;
                  }}
                  id={inputId}
                  type={field.type ?? "text"}
                  value={request.values[index] ?? ""}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  className="omni-prompt-dialog__input"
                  onChange={(event) => handleFieldChange(index, event.target.value)}
                />
              </label>
            );
          })}

          {validationMessage ? <div className="omni-prompt-dialog__error">{validationMessage}</div> : null}
        </div>

        <div className="omni-confirm-dialog__actions omni-prompt-dialog__actions">
          <button type="button" className="omni-confirm-dialog__button" onClick={handleCancel}>
            <X size={13} strokeWidth={2} />
            <span>{request.options.cancelLabel ?? "取消"}</span>
          </button>
          <button
            type="button"
            className="omni-confirm-dialog__button omni-confirm-dialog__button--primary"
            onClick={handleConfirm}
          >
            <Check size={13} strokeWidth={2} />
            <span>{request.options.confirmLabel ?? "确认"}</span>
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <PromptDialogContext.Provider value={contextValue}>
      {children}
      {portalTarget && promptDialog ? createPortal(promptDialog, portalTarget) : null}
    </PromptDialogContext.Provider>
  );
}
