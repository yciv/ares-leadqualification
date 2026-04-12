"use client";

import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

interface ShellProps {
  children: React.ReactNode;
  title: string;
  email: string;
}

export function Shell({ children, title, email }: ShellProps) {
  return (
    <div className="flex min-h-screen">
      <Sidebar email={email} />
      <div className="flex flex-1 flex-col pl-[200px]">
        <Topbar title={title} email={email} />
        <main className="flex-1 bg-bg-base p-6">{children}</main>
      </div>
    </div>
  );
}
