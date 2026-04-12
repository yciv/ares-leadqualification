"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FolderKanban, Settings, LogOut } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
}

const navItems: NavItem[] = [
  { label: "Projects", href: "/projects", icon: FolderKanban },
];

const bottomNavItems: NavItem[] = [
  { label: "Settings", href: "#", icon: Settings, disabled: true },
];

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const initial = email?.charAt(0).toUpperCase() ?? "?";

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[200px] flex-col bg-bg-surface border-r border-border-default">
      {/* Logo */}
      <div className="flex h-12 items-center px-5">
        <span className="text-lg font-semibold tracking-[0.05em] text-text-primary">
          ARES<span className="text-accent-gold">.</span>
        </span>
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col px-3 pt-2 gap-1">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                active
                  ? "text-accent-gold bg-accent-gold-subtle border-l-2 border-accent-gold"
                  : "text-text-muted hover:text-text-primary hover:bg-bg-elevated"
              )}
            >
              <item.icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}

        <Separator className="my-2" />

        {bottomNavItems.map((item) => (
          <span
            key={item.label}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-text-muted cursor-not-allowed opacity-50"
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
          </span>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* User section */}
        <div className="border-t border-border-default py-3 px-1 flex items-center gap-2.5">
          <Avatar size="sm">
            <AvatarFallback className="bg-bg-elevated text-text-secondary text-xs">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="flex-1 truncate text-xs text-text-secondary">
            {email}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleSignOut}
            aria-label="Sign out"
          >
            <LogOut className="size-3.5 text-text-muted" />
          </Button>
        </div>
      </nav>
    </aside>
  );
}
