import { create } from "zustand";
import { createBrowserClient } from "@/lib/supabase/browser";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResultLead {
  id: string;
  company_name: string;
  canonical_domain: string;
  status: string;
  fit_score: number | null;
  cluster_label: string | null;
  routing_flag: string | null;
  scored_at: string | null;
  _overridden?: boolean;
  crux_data: { crux_rank: number | null } | null;
  standardized_data: {
    tech_maturity_score: number | null;
    stack_archetype: string | null;
  } | null;
  linkup_data: {
    industry: string | null;
  } | null;
}

export interface Thresholds {
  ae: number;     // default 0.85
  sdr: number;    // default 0.72
  nurture: number; // default 0.60
}

// ─── Routing helpers ──────────────────────────────────────────────────────────

function applyThresholds(
  lead: ResultLead,
  thresholds: Thresholds
): Pick<ResultLead, "routing_flag" | "cluster_label"> {
  const score = lead.fit_score ?? 0;
  const matched = lead.cluster_label;

  if (score >= thresholds.ae)    return { routing_flag: "AE",     cluster_label: matched };
  if (score >= thresholds.sdr)   return { routing_flag: "SDR",    cluster_label: matched };
  if (score >= thresholds.nurture) return { routing_flag: "nurture", cluster_label: "fringe" };
  return                                  { routing_flag: "reject",  cluster_label: "no_match" };
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface ResultsStore {
  leads: ResultLead[];
  thresholds: Thresholds;
  reviewCount: number;

  setLeads: (leads: ResultLead[]) => void;
  setThreshold: (tier: keyof Thresholds, value: number) => void;
  overrideRouting: (leadId: string, newFlag: string) => void;
}

export const useResultsStore = create<ResultsStore>((set, get) => ({
  leads: [],
  thresholds: { ae: 0.85, sdr: 0.72, nurture: 0.60 },
  reviewCount: 0,

  setLeads(leads) {
    set({ leads });
  },

  setThreshold(tier, value) {
    const thresholds = { ...get().thresholds, [tier]: value };
    set({
      thresholds,
      // Re-apply routing for every non-overridden lead
      leads: get().leads.map((lead) => {
        if (lead._overridden) return lead;
        const routing = applyThresholds(lead, thresholds);
        return { ...lead, ...routing };
      }),
    });
  },

  overrideRouting(leadId, newFlag) {
    set((state) => ({
      reviewCount: state.reviewCount + 1,
      leads: state.leads.map((lead) =>
        lead.id === leadId
          ? { ...lead, routing_flag: newFlag, _overridden: true }
          : lead
      ),
    }));

    // Async DB persist — fire and forget (errors are logged, not thrown)
    const supabase = createBrowserClient();
    supabase
      .from("leads")
      .update({ routing_flag: newFlag })
      .eq("id", leadId)
      .then(({ error }) => {
        if (error) {
          console.error("[resultsStore] Failed to persist routing override:", error.message);
        }
      });
  },
}));
