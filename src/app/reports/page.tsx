import { redirect } from "next/navigation";

import AppHeader from "@/components/app-header";
import ReportsBoard from "@/components/reports-board";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/");
  if (session.role !== "controller") redirect("/book");

  return (
    <>
      <AppHeader role="controller" displayName={session.name} />
      <ReportsBoard />
    </>
  );
}
