"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import Papa from "papaparse";

type ProjectType = "seed" | "test" | "live";

interface ParsedLead {
  company_name: string;
  canonical_domain: string;
  source_tag?: string;
  _errors: string[];
}

const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
const SEED_TEST_MAX = 100;

function validateLead(row: Record<string, string>): ParsedLead {
  const errors: string[] = [];
  const company_name = row["company_name"]?.trim() ?? "";
  const canonical_domain = row["canonical_domain"]?.trim() ?? "";

  if (!company_name) errors.push("Missing company_name");
  if (!canonical_domain) {
    errors.push("Missing canonical_domain");
  } else if (!DOMAIN_RE.test(canonical_domain)) {
    errors.push(`Invalid domain format: "${canonical_domain}"`);
  }

  return {
    company_name,
    canonical_domain,
    source_tag: row["source_tag"]?.trim() || undefined,
    _errors: errors,
  };
}

export default function NewProjectPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("seed");
  const [leads, setLeads] = useState<ParsedLead[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileError(null);
    setLeads([]);

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete(results) {
        const parsed = results.data.map(validateLead);

        if (
          (projectType === "seed" || projectType === "test") &&
          parsed.length > SEED_TEST_MAX
        ) {
          setFileError(
            `${projectType} projects are limited to ${SEED_TEST_MAX} rows. This file has ${parsed.length}.`
          );
          setLeads([]);
          return;
        }

        setLeads(parsed);
      },
      error(err) {
        setFileError(`Failed to parse CSV: ${err.message}`);
      },
    });
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (!file || !file.name.endsWith(".csv")) return;
      // Reuse the existing file handler by assigning to the input
      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileRef.current) {
        fileRef.current.files = dt.files;
        fileRef.current.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const hasLeadErrors = leads.some((l) => l._errors.length > 0);
  const canSubmit =
    name.trim() !== "" &&
    leads.length > 0 &&
    !hasLeadErrors &&
    !fileError &&
    !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          project_type: projectType,
          leads: leads.map(({ company_name, canonical_domain, source_tag }) => ({
            company_name,
            canonical_domain,
            source_tag,
          })),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Server error ${res.status}`);
      }

      const { projectId } = await res.json();
      router.push(`/projects/${projectId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="mb-8 text-2xl font-bold">New Project</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Project Metadata */}
        <div className="rounded-xl border border-border-default bg-bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-text-muted">
            Project Details
          </h2>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">
              Name <span className="text-status-danger">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q2 ICP Seed"
              className="w-full rounded-lg border border-border-default bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-border-focus focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional context about this batch"
              rows={2}
              className="w-full rounded-lg border border-border-default bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-border-focus focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-secondary">
              Project Type
            </label>
            <div className="flex gap-3">
              {(["seed", "test", "live"] as ProjectType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setProjectType(t);
                    // Re-validate row count when type changes
                    if (
                      (t === "seed" || t === "test") &&
                      leads.length > SEED_TEST_MAX
                    ) {
                      setFileError(
                        `${t} projects are limited to ${SEED_TEST_MAX} rows. This file has ${leads.length}.`
                      );
                      setLeads([]);
                    } else if (t === "live" && fileError?.includes("limited to")) {
                      setFileError(null);
                    }
                  }}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                    projectType === t
                      ? "bg-accent-gold text-text-inverse"
                      : "border border-border-default text-text-secondary hover:border-border-hover"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            {(projectType === "seed" || projectType === "test") && (
              <p className="mt-1.5 text-xs text-text-muted">
                Max {SEED_TEST_MAX} rows for {projectType} projects.
              </p>
            )}
          </div>
        </div>

        {/* CSV Upload */}
        <div className="rounded-xl border border-border-default bg-bg-surface p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-text-muted">
            Lead CSV
          </h2>
          <p className="text-xs text-text-muted">
            Required columns:{" "}
            <code className="rounded bg-bg-elevated px-1 py-0.5">company_name</code>,{" "}
            <code className="rounded bg-bg-elevated px-1 py-0.5">canonical_domain</code>.
            Optional:{" "}
            <code className="rounded bg-bg-elevated px-1 py-0.5">source_tag</code>.
            Domains must be plain (e.g.{" "}
            <code className="rounded bg-bg-elevated px-1 py-0.5">example.com</code>
            , no https://).
          </p>

          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 transition-colors ${
              dragging
                ? "border-border-focus bg-bg-elevated"
                : "border-border-default bg-bg-surface hover:bg-bg-elevated"
            }`}
          >
            <Upload className="h-8 w-8 text-text-muted" />
            <p className="text-sm text-text-secondary">
              Drag &amp; drop a CSV file or click to browse
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleFile}
            className="hidden"
          />

          {fileError && (
            <p className="rounded-lg border border-status-danger/20 bg-status-danger/10 px-4 py-2 text-sm text-status-danger">
              {fileError}
            </p>
          )}

          {leads.length > 0 && (
            <div>
              <p className="mb-2 text-xs text-text-muted">
                {leads.length} row{leads.length !== 1 ? "s" : ""} loaded
                {hasLeadErrors && (
                  <span className="ml-2 text-status-danger">
                    ({leads.filter((l) => l._errors.length > 0).length} with errors)
                  </span>
                )}
              </p>

              {/* Preview Table */}
              <div className="overflow-x-auto rounded-lg border border-border-default">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border-default bg-bg-elevated text-text-muted">
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">company_name</th>
                      <th className="px-3 py-2">canonical_domain</th>
                      <th className="px-3 py-2">source_tag</th>
                      <th className="px-3 py-2">status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead, i) => {
                      const hasError = lead._errors.length > 0;
                      return (
                        <tr
                          key={i}
                          className={`border-b border-border-default ${
                            hasError ? "bg-status-danger/10" : "hover:bg-bg-elevated/50"
                          }`}
                        >
                          <td className="px-3 py-1.5 text-text-muted">{i + 1}</td>
                          <td className="px-3 py-1.5 text-text-primary">
                            {lead.company_name || (
                              <span className="text-status-danger italic">missing</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-text-primary">
                            {lead.canonical_domain || (
                              <span className="text-status-danger italic">missing</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-text-secondary">
                            {lead.source_tag ?? "—"}
                          </td>
                          <td className="px-3 py-1.5">
                            {hasError ? (
                              <span
                                className="text-status-danger"
                                title={lead._errors.join("; ")}
                              >
                                ✗ {lead._errors[0]}
                              </span>
                            ) : (
                              <span className="text-status-success">✓</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {submitError && (
          <p className="rounded-lg border border-status-danger/20 bg-status-danger/10 px-4 py-2 text-sm text-status-danger">
            {submitError}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-accent-gold px-6 py-2.5 text-sm font-semibold text-text-inverse transition-colors hover:bg-accent-gold-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Creating…" : "Create Project & Start Enrichment"}
          </button>
        </div>
      </form>
    </div>
  );
}
