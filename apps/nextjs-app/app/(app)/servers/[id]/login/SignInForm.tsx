"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Zap } from "lucide-react";
import { useRouter } from "nextjs-toploader/app";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Spinner } from "@/components/Spinner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  cancelQuickConnect,
  login,
  pollQuickConnect,
  startQuickConnect,
} from "@/lib/auth";
import type { ServerPublic } from "@/lib/types";

const FormSchema = z.object({
  username: z.string(),
  password: z.string().optional(),
});

const QUICK_CONNECT_POLL_MS = 3000;

interface Props {
  server: ServerPublic;
  servers: ServerPublic[];
  quickConnectEnabled?: boolean;
}

export const SignInForm: React.FC<Props> = ({
  server,
  servers,
  quickConnectEnabled = false,
}) => {
  const [loading, setLoading] = useState(false);
  const [quickConnectCode, setQuickConnectCode] = useState<string | null>(null);
  const [quickConnectStarting, setQuickConnectStarting] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!quickConnectCode) return;

    let active = true;
    const interval = setInterval(() => {
      void (async () => {
        const result = await pollQuickConnect({ serverId: server.id });
        if (!active) return;

        if (result.status === "authorized") {
          toast.success("Logged in successfully");
          router.push(`/servers/${server.id}/dashboard`);
        } else if (result.status === "expired") {
          toast.error("Quick Connect code expired. Please try again.");
          setQuickConnectCode(null);
        } else if (result.status === "error") {
          toast.error(result.error);
          setQuickConnectCode(null);
        }
        // "pending": keep polling
      })();
    }, QUICK_CONNECT_POLL_MS);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [quickConnectCode, router, server.id]);

  const handleStartQuickConnect = async () => {
    setQuickConnectStarting(true);
    try {
      const result = await startQuickConnect({
        serverId: server.id,
        userAgent: navigator.userAgent,
      });
      if (result.success) {
        setQuickConnectCode(result.code);
      } else {
        toast.error(result.error);
      }
    } catch (error) {
      console.error("Error starting Quick Connect:", error);
      toast.error("Failed to start Quick Connect");
    } finally {
      setQuickConnectStarting(false);
    }
  };

  const handleCancelQuickConnect = async () => {
    setQuickConnectCode(null);
    try {
      await cancelQuickConnect();
    } catch {
      // Cookie simply expires if the cancel round-trip fails
    }
  };
  const form = useForm<z.infer<typeof FormSchema>>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      username: "",
      password: "",
    },
  });

  async function onSubmit(data: z.infer<typeof FormSchema>) {
    setLoading(true);
    try {
      await login({
        serverId: server.id,
        username: data.username,
        password: data.password || "",
        userAgent: navigator.userAgent,
      });
      toast.success("Logged in successfully");
      router.push(`/servers/${server.id}/dashboard`);
    } catch (error) {
      toast.error("Error logging in");
      console.error("Error logging in:", error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen w-full items-center justify-center px-4">
      <Card className="mx-auto lg:min-w-[400px]">
        <CardHeader>
          <CardTitle className="text-2xl">
            Log in to{" "}
            <span className="font-bold text-blue-500">{server.name}</span>
          </CardTitle>
          <CardDescription>
            Log in to Streamystats by using your Jellyfin account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="w-full space-y-6"
            >
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="John"
                        {...field}
                        autoComplete="username"
                      />
                    </FormControl>
                    <FormDescription>
                      Enter your Jellyfin username
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder="**********"
                        {...field}
                        autoComplete="current-password"
                      />
                    </FormControl>
                    <FormDescription>Jellyfin password</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type="submit">{loading ? <Spinner /> : "Sign In"}</Button>
            </form>
          </Form>

          {quickConnectEnabled && (
            <div className="mt-6 space-y-4">
              <div className="flex items-center">
                <div className="h-px flex-1 bg-border" />
                <span className="px-2 text-xs text-muted-foreground">Or</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {quickConnectCode ? (
                <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    Enter this code in your Jellyfin app under{" "}
                    <span className="font-medium text-foreground">
                      Settings &rarr; Quick Connect
                    </span>
                  </p>
                  <p className="text-3xl font-bold tracking-[0.3em] text-blue-500">
                    {quickConnectCode}
                  </p>
                  <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    <Spinner />
                    Waiting for approval&hellip;
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancelQuickConnect}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleStartQuickConnect}
                  disabled={quickConnectStarting}
                >
                  {quickConnectStarting ? (
                    <Spinner />
                  ) : (
                    <>
                      <Zap className="mr-2 h-4 w-4" />
                      Sign in with Quick Connect
                    </>
                  )}
                </Button>
              )}
            </div>
          )}

          {/* Only show this section if there are other servers available */}
          {servers.filter((s) => s.id !== server.id).length > 0 && (
            <div className="mt-6 space-y-4">
              <div className="flex items-center">
                <div className="h-px flex-1 bg-border" />
                <span className="px-2 text-xs text-muted-foreground">
                  Or select another server
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className="space-y-2">
                <div className="grid gap-2">
                  {servers
                    .filter((s) => s.id !== server.id)
                    .map((s) => (
                      <Button
                        key={s.id}
                        variant="outline"
                        className="flex w-full justify-between rainbow-border-glow"
                        onClick={() => router.push(`/servers/${s.id}/login`)}
                      >
                        <span className="font-medium">{s.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {s.url}
                        </span>
                      </Button>
                    ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
