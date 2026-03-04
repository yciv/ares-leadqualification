"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
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
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
            Project Details
          </h2>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q2 ICP Seed"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional context about this batch"
              rows={2}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">
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
                  className={`rounded-lg px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                    projectType === t
                      ? "bg-indigo-600 text-white"
                      : "border border-gray-700 text-gray-400 hover:border-gray-500"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            {(projectType === "seed" || projectType === "test") && (
              <p className="mt-1.5 text-xs text-gray-500">
                Max {SEED_TEST_MAX} rows for {projectType} projects.
              </p>
            )}
          </div>
        </div>

        {/* CSV Upload */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
            Lead CSV
          </h2>
          <p className="text-xs text-gray-500">
            Required columns:{" "}
            <code className="rounded bg-gray-800 px-1 py-0.5">company_name</code>,{" "}
            <code className="rounded bg-gray-800 px-1 py-0.5">canonical_domain</code>.
            Optional:{" "}
            <code className="rounded bg-gray-800 px-1 py-0.5">source_tag</code>.
            Domains must be plain (e.g.{" "}
            <code className="rounded bg-gray-800 px-1 py-0.5">example.com</code>
            , no https://).
          </p>

          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleFile}
            className="block w-full text-sm text-gray-400 file:mr-4 file:rounded-lg file:border-0 file:bg-indigo-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-indigo-500"
          />

          {fileError && (
            <p className="rounded-lg border border-red-800 bg-red-950 px-4 py-2 text-sm text-red-400">
              {fileError}
            </p>
          )}

          {leads.length > 0 && (
            <div>
              <p className="mb-2 text-xs text-gray-500">
                {leads.length} row{leads.length !== 1 ? "s" : ""} loaded
                {hasLeadErrors && (
                  <span className="ml-2 text-red-400">
                    ({leads.filter((l) => l._errors.length > 0).length} with errors)
                  </span>
                )}
              </p>

              {/* Preview Table */}
              <div className="overflow-x-auto rounded-lg border border-gray-700">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-gray-700 bg-gray-800 text-gray-400">
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
                          className={`border-b border-gray-800 ${
                            hasError ? "bg-red-950/40" : "hover:bg-gray-800/50"
                          }`}
                        >
                          <td className="px-3 py-1.5 text-gray-500">{i + 1}</td>
                          <td className="px-3 py-1.5 text-gray-200">
                            {lead.company_name || (
                              <span className="text-red-400 italic">missing</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-gray-200">
                            {lead.canonical_domain || (
                              <span className="text-red-400 italic">missing</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-gray-400">
                            {lead.source_tag ?? "—"}
                          </td>
                          <td className="px-3 py-1.5">
                            {hasError ? (
                              <span
                                className="text-red-400"
                                title={lead._errors.join("; ")}
                              >
                                ✗ {lead._errors[0]}
                              </span>
                            ) : (
                              <span className="text-green-400">✓</span>
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
          <p className="rounded-lg border border-red-800 bg-red-950 px-4 py-2 text-sm text-red-400">
            {submitError}
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Creating…" : "Create Project & Start Enrichment"}
          </button>
        </div>
      </form>
    </div>
  );
}
