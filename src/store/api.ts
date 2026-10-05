import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { CourtEnvelope, LegacyEnvelope } from "../types";

const KEY = "pair-wise-yf-49/court";

export type HydratePayload = CourtEnvelope | LegacyEnvelope | null;

export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getCourt: builder.query<HydratePayload, void>({
      queryFn: async () => {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { data: null };
        const parsed = JSON.parse(raw) as Partial<CourtEnvelope> & { evidence?: LegacyEnvelope["evidence"] };
        // v2：带会话台账
        if (parsed.version === 2 && parsed.ledger) return { data: parsed as CourtEnvelope };
        // 旧记录：只有证据、缺会话号，交给 store 升级为单条
        return { data: parsed.evidence ? { legacy: true, evidence: parsed.evidence } : null };
      }
    }),
    saveCourt: builder.mutation<{ ok: true }, CourtEnvelope>({
      queryFn: async (payload) => {
        localStorage.setItem(KEY, JSON.stringify(payload));
        return { data: { ok: true } };
      }
    })
  })
});

export const { useGetCourtQuery, useSaveCourtMutation } = courtApi;
