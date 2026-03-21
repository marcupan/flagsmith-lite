import {useCallback, useEffect, useRef, useState, type SubmitEventHandler} from "react";
import type {CreateFlagBody, Flag} from "@project/shared";
import {createFlag, deleteFlag, listFlags, updateFlag} from "./api";

type Status = "idle" | "loading" | "error";

export default function App() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);

    try {
      setFlags(await listFlags());
      setStatus("idle");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = async (flag: Flag) => {
    try {
      const updated = await updateFlag(flag.key, {enabled: !flag.enabled});

      setFlags((prev) => prev.map((f) => (f.key === flag.key ? updated : f)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete flag "${key}"?`)) {
      return;
    }

    try {
      await deleteFlag(key);

      setFlags((prev) => prev.filter((f) => f.key !== key));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 800,
        margin: "0 auto",
        padding: "2rem",
      }}
    >
      <header
        style={{
          borderBottom: "1px solid #e5e7eb",
          paddingBottom: "1rem",
          marginBottom: "2rem",
        }}
      >
        <h1 style={{margin: 0, fontSize: "1.5rem", fontWeight: 700}}>Feature Flags</h1>
        <p
          style={{
            margin: "0.25rem 0 0",
            color: "#6b7280",
            fontSize: "0.875rem",
          }}
        >
          {import.meta.env.VITE_API_URL ?? "http://localhost:3000"}
        </p>
      </header>

      {error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: 6,
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
            color: "#991b1b",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <span style={{color: "#6b7280", fontSize: "0.875rem"}}>
          {status === "loading"
            ? "Loading\u2026"
            : `${flags.length} flag${flags.length !== 1 ? "s" : ""}`}
        </span>
        <button
          style={{
            padding: "0.5rem 1rem",
            background: "#1d4ed8",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontWeight: 600,
          }}
          onClick={() => setCreating(true)}
        >
          + New flag
        </button>
      </div>

      {creating && (
        <CreateFlagForm
          onCreated={(flag) => {
            setFlags((prev) => [flag, ...prev]);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {status !== "loading" && flags.length === 0 && !creating && (
        <p style={{textAlign: "center", color: "#9ca3af", paddingTop: "3rem"}}>
          No flags yet. Create one above.
        </p>
      )}

      <div style={{display: "flex", flexDirection: "column", gap: "0.75rem"}}>
        {flags.map((flag) => (
          <FlagRow key={flag.key} flag={flag} onToggle={handleToggle} onDelete={handleDelete}/>
        ))}
      </div>
    </div>
  );
}

function FlagRow({
 flag,
 onToggle,
 onDelete,
}: {
  flag: Flag;
  onToggle: (f: Flag) => void;
  onDelete: (key: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "1rem",
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        background: flag.enabled ? "#f0fdf4" : "#fff",
      }}
    >
      <button
        title={flag.enabled ? "Disable" : "Enable"}
        style={{
          width: 44,
          height: 24,
          borderRadius: 12,
          border: "none",
          background: flag.enabled ? "#16a34a" : "#d1d5db",
          cursor: "pointer",
          flexShrink: 0,
          transition: "background 0.15s",
        }}
        aria-checked={flag.enabled}
        role="switch"
        onClick={() => onToggle(flag)}
      />
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{fontWeight: 600, fontSize: "0.875rem"}}>{flag.name}</div>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "0.75rem",
            color: "#6b7280",
            marginTop: 2,
          }}
        >
          {flag.key}
        </div>
        {flag.description && (
          <div style={{fontSize: "0.75rem", color: "#9ca3af", marginTop: 2}}>
            {flag.description}
          </div>
        )}
      </div>
      <span
        style={{
          fontSize: "0.75rem",
          fontWeight: 600,
          padding: "0.25rem 0.5rem",
          borderRadius: 4,
          background: flag.enabled ? "#dcfce7" : "#f3f4f6",
          color: flag.enabled ? "#166534" : "#6b7280",
        }}
      >
        {flag.enabled ? "enabled" : "disabled"}
      </span>
      <button
        title="Delete flag"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "#9ca3af",
          fontSize: "1rem",
          padding: 4,
        }}
        onClick={() => onDelete(flag.key)}
      >
        ✕
      </button>
    </div>
  );
}

function CreateFlagForm({
  onCreated,
  onCancel,
}: {
  onCreated: (flag: Flag) => void;
  onCancel: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLInputElement>(null);

  const handleSubmit: SubmitEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    const body: CreateFlagBody = {
      key: keyRef.current!.value.trim(),
      name: nameRef.current!.value.trim(),
      description: descRef.current!.value.trim() || undefined,
    };

    if (!body.key || !body.name) {
      setFormError("Key and name are required");

      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      onCreated(await createFlag(body));
    } catch (err) {
      setFormError((err as Error).message);
      setSubmitting(false);
    }
  };

  const inputStyle = {
    padding: "0.5rem 0.75rem",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    fontSize: "0.875rem",
    width: "100%",
    boxSizing: "border-box" as const,
  };

  return (
    <form
      style={{
        border: "1px dashed #93c5fd",
        borderRadius: 8,
        padding: "1rem",
        marginBottom: "1rem",
        background: "#eff6ff",
      }}
      onSubmit={handleSubmit}
    >
      <h3 style={{margin: "0 0 0.75rem", fontSize: "0.875rem", fontWeight: 700}}>New Flag</h3>
      {formError && (
        <p style={{color: "#dc2626", fontSize: "0.8rem", margin: "0 0 0.5rem"}}>{formError}</p>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        <input ref={keyRef} placeholder="key (e.g. dark-mode)" style={inputStyle}/>
        <input ref={nameRef} placeholder="Name" style={inputStyle}/>
      </div>
      <input
        ref={descRef}
        placeholder="Description (optional)"
        style={{...inputStyle, marginBottom: "0.75rem"}}
      />
      <div style={{display: "flex", gap: "0.5rem"}}>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: "0.5rem 1rem",
            background: "#1d4ed8",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {submitting ? "Creating\u2026" : "Create"}
        </button>
        <button
          type="button"
          style={{
            padding: "0.5rem 1rem",
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            cursor: "pointer",
          }}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
