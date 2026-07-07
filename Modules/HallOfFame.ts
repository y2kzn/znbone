import { ITournament } from "../Models/Tournament";
import { BackboneUser } from "../Models/BackboneUser";
import { msg, warn } from "./Logger";

interface TopPlayer {
  position: number;
  nick: string;
  userId: string;
}

export async function SendHallOfFameEmbed(tournament: ITournament, topPlayers: TopPlayer[]): Promise<void> {
  const url = process.env.HALL_OF_FAME_WEBHOOK_URI || "";
  if (!url) { warn("HallOfFame: HALL_OF_FAME_WEBHOOK_URI not set"); return; }

  try {
    const top10 = topPlayers.slice(0, 10);
    if (top10.length === 0) { warn("HallOfFame: no players to show"); return; }

    let description = "**Top 10**\n\n";
    for (const player of top10) {
      const medal = player.position === 1 ? "🥇" : player.position === 2 ? "🥈" : player.position === 3 ? "🥉" : "•";
      description += `${medal} **${player.position}º** - ${player.nick}\n`;
    }

    const hexColor = (tournament.TournamentColor || "#5865F2").replace("#", "").substring(0, 6);
    const embed = {
      title: tournament.TournamentName,
      description,
      color: parseInt(hexColor, 16),
      thumbnail: tournament.TournamentImage ? { url: tournament.TournamentImage } : undefined,
      timestamp: new Date().toISOString(),
      footer: { text: "Hall da Fama" },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const text = await res.text();
      warn(`HallOfFame webhook failed: ${res.status} - ${text}`);
      return;
    }

    msg(`Hall of Fame sent for: ${tournament.TournamentName}`);
  } catch (error) {
    warn(`HallOfFame failed: ${error}`);
  }
}

export async function GenerateHallOfFame(tournament: ITournament, winnerUserIds: string[]): Promise<void> {
  try {
    const tournamentId = tournament.TournamentId.toString();

    if (!winnerUserIds.length) { warn("HallOfFame: no winner ids"); return; }

    const topPlayers: TopPlayer[] = [];
    const phaseId = tournament.CurrentPhaseId || 1;

    const allUsers = await BackboneUser.find({
      [`Tournaments.${tournamentId}.SignedUp`]: true,
    }).lean();

    const teamMap = new Map<string, { nick: string; rank: number; userId: string }>();

    for (const user of allUsers) {
      const data = (user.Tournaments as any).get
        ? (user.Tournaments as any).get(tournamentId)
        : (user.Tournaments as any)[tournamentId];
      if (!data) continue;

      const pos = data.UserPosition?.find((p: any) => p.phaseid === phaseId);
      if (!pos || pos.rankposition <= 0) continue;

      let leaderId = user.UserId;
      if (data.PartyMembers?.length) {
        const leader = data.PartyMembers.find((m: any) => m.IsPartyLeader);
        if (leader) leaderId = leader.UserId;
      }

      if (teamMap.has(leaderId)) continue;

      const nick = tournament.PartySize > 1 && data.PartyMembers?.length
        ? data.PartyMembers.map((m: any) => m.Username).join(" & ")
        : user.Username;

      teamMap.set(leaderId, { nick, rank: pos.rankposition, userId: user.UserId });
    }

    for (const uid of winnerUserIds) {
      const winner = allUsers.find((u: any) => u.UserId === uid);
      if (!winner) continue;
      const data = (winner.Tournaments as any).get
        ? (winner.Tournaments as any).get(tournamentId)
        : (winner.Tournaments as any)[tournamentId];
      const nick = tournament.PartySize > 1 && data?.PartyMembers?.length
        ? data.PartyMembers.map((m: any) => m.Username).join(" & ")
        : winner.Username;
      teamMap.set(uid, { nick, rank: 1, userId: uid });
    }

    for (const [, val] of teamMap) {
      topPlayers.push({ position: val.rank, nick: val.nick, userId: val.userId });
    }

    topPlayers.sort((a, b) => a.position - b.position);

    if (topPlayers.length === 0 || topPlayers[0].position !== 1) {
      const winner = allUsers.find((u: any) => winnerUserIds.includes(u.UserId));
      if (winner) topPlayers.unshift({ position: 1, nick: winner.Username, userId: winner.UserId });
    }

    await SendHallOfFameEmbed(tournament, topPlayers);
  } catch (error) {
    warn(`HallOfFame generate failed: ${error}`);
  }
}
