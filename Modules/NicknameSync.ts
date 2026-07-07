import { Match } from "../Models/Matches";
import { Tournament } from "../Models/Tournament";

export async function SyncNicknameInTournamentData(
  userId: string,
  newNickname: string
): Promise<void> {
  await Promise.all([
    Match.updateMany(
      { "users.@user-id": userId },
      { $set: { "users.$[u].@nick": newNickname } },
      { arrayFilters: [{ "u.@user-id": userId }] }
    ),
    Tournament.updateMany(
      { "Winners.userId": userId },
      { $set: { "Winners.$[w].nick": newNickname } },
      { arrayFilters: [{ "w.userId": userId }] }
    ),
  ]);
}
