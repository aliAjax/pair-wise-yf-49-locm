import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { PersistedState } from "../types";

const KEY = "pair-wise-yf-49/court";

const emptyState: PersistedState = {
  evidence: [],
  objections: [],
  timeline: [],
  snapshots: [],
  session: { phase: "举证", currentEvidenceId: null, timerSeconds: 0, operatorMode: "庭审控制" },
  displaySessions: [],
  publicScreen: { confirmedRevision: 0, currentSessionId: null, lastConfirmedAt: null },
  settlements: [],
  revisionCounter: 0,
  online: true
};

function readState(): PersistedState {
  const raw = localStorage.getItem(KEY);
  if (!raw) return emptyState;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return { ...emptyState, ...parsed, publicScreen: { ...emptyState.publicScreen, ...(parsed.publicScreen ?? {}) } };
  } catch {
    return emptyState;
  }
}

export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getCourtState: builder.query<PersistedState, void>({ queryFn: async () => ({ data: readState() }) }),
    saveCourtState: builder.mutation<{ ok: true }, PersistedState>({
      queryFn: async (payload) => { localStorage.setItem(KEY, JSON.stringify(payload)); return { data: { ok: true } }; }
    })
  })
});

export const { useGetCourtStateQuery, useSaveCourtStateMutation } = courtApi;
