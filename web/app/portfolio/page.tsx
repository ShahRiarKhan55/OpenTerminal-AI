"use client";

import dynamic from "next/dynamic";

// Client-only: the page formats dates in Japan time and reads live data, so it is never server-rendered.
const InvestmentsPage = dynamic(() => import("../../components/investments/InvestmentsPage"), { ssr: false });

export default function PortfolioRoute() {
  return <InvestmentsPage />;
}
