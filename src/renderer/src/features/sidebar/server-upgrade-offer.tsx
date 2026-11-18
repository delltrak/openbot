import type { ServerSummary } from "@openbot/contracts/ipc";
import type { SidebarStorageLevel } from "@openbot/ui/features/sidebar/SidebarStorageCard";

interface StorageCard {
  level: SidebarStorageLevel;
  serverId: string;
  freeBytes: number;
  totalBytes: number;
}

/** The local build shows the storage card without opening the cloud billing dialog. */
export function ServerUpgradeOffer(_props: {
  billing?: unknown;
  card: StorageCard | null;
  server: ServerSummary | undefined;
  blocked: boolean;
  onFreeUpSpace: (serverId: string) => void;
}) {
  return null;
}
