import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/";

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Beta gate: check if user's email is in allowed_emails
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) {
        const { data: allowed } = await supabase
          .from("allowed_emails")
          .select("email")
          .eq("email", user.email)
          .single();

        if (!allowed) {
          // Not in beta — sign them out and redirect to login with error
          await supabase.auth.signOut();
          const loginUrl = request.nextUrl.clone();
          loginUrl.pathname = "/login";
          loginUrl.searchParams.set("error", "not_authorized");
          loginUrl.searchParams.delete("code");
          loginUrl.searchParams.delete("next");
          return NextResponse.redirect(loginUrl);
        }
      }

      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = next;
      redirectUrl.searchParams.delete("code");
      redirectUrl.searchParams.delete("next");
      return NextResponse.redirect(redirectUrl);
    }
  }

  // Auth failed — redirect to login with error
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("error", "auth_failed");
  loginUrl.searchParams.delete("code");
  loginUrl.searchParams.delete("next");
  return NextResponse.redirect(loginUrl);
}
