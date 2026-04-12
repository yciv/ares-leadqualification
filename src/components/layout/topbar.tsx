"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface TopbarProps {
  title: string;
  email: string;
}

export function Topbar({ title, email }: TopbarProps) {
  const initial = email?.charAt(0).toUpperCase() ?? "?";

  return (
    <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-border-default bg-bg-surface px-6">
      <h1 className="text-sm font-semibold text-text-primary">{title}</h1>
      <Avatar size="sm">
        <AvatarFallback className="bg-bg-elevated text-text-secondary text-xs">
          {initial}
        </AvatarFallback>
      </Avatar>
    </header>
  );
}
