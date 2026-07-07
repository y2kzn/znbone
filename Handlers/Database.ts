import { BackboneUser } from "../Models/BackboneUser";
import { ITournament, Tournament, TournamentInput } from "../Models/Tournament";
import { v4 as uuidv4 } from "uuid";
import { msg } from "../Modules/Logger";
import { GenerateInviteId } from "../Modules/Extensions";
import { GetStarDatabase } from "./Server";
import {
  TournamentPhaseType,
  Scenes,
  Emotes,
  TournamentRegion,
  EmoteGroupDefinitions,
  EmoteEmojis,
  TournamentSignUpStatus,
  TournamentUserStatus,
  TournamentStatus,
  TournamentMatchStatus
} from "../Backbone/Config";
import { LPUser } from "../Models/LPUser";

const WEBHOOK_URI = process.env.WEBHOOK_URI || "";

function getMapFriendlyName(sceneId: string): string {
  const mapName = Object.keys(Scenes).find((key) => Scenes[key as keyof typeof Scenes] === sceneId);
  return mapName || sceneId;
}

function getEmoteFriendlyName(emoteId: number): string {
  if (emoteId <= -1000) {
    const mask = -(emoteId + 1000);
    const parts: string[] = [];

    if (mask === -1) {
      for (const emoteName in EmoteEmojis) {
        parts.push(EmoteEmojis[emoteName]);
      }
      return parts.join(" ");
    }

    for (const key in EmoteGroupDefinitions) {
      const group = EmoteGroupDefinitions[key];

      if ((mask & group.mask) !== 0) {
        for (const emoteName of group.emotes as string[]) {
          parts.push(EmoteEmojis[emoteName] ?? emoteName);
        }
      }
    }

    return parts.length > 0 ? parts.join(" ") : "None";
  }

  const emoteName = Object.keys(Emotes).find(
    key => Emotes[key as keyof typeof Emotes] === emoteId
  );

  if (emoteName && EmoteEmojis[emoteName]) {
    return EmoteEmojis[emoteName];
  }

  return emoteName || `${emoteId}`;
}


const getPhaseTypeName = (phaseType: number): string => {
  switch (phaseType) {
    case TournamentPhaseType.RoundRobin:
      return "RR Group (Phases)";
    case TournamentPhaseType.Arena:
      return "Arena";
    case TournamentPhaseType.SingleEliminationBracket:
      return "SE Bracket";
    case TournamentPhaseType.DoubleEliminationBracket:
      return "DE Bracket";
    case TournamentPhaseType.DynamicBrackets:
      return "Dynamic Bracket";
    default:
      return "Phase";
  }
};

export async function AddGems(amount: number, userId: string): Promise<boolean> {
  try {
    const db = GetStarDatabase();
    const users = db.collection("Users");

    const result = await users.updateOne(
      { id: parseInt(userId) },
      { $inc: { "balances.3.amount": amount } }
    );

    return result.modifiedCount > 0;
  } catch (error) {
    throw new Error("Erro ao adicionar gems ao usuário: " + error);
  }
}

export async function RemoveGems(amount: number, userId: string): Promise<boolean> {
  try {
    const db = GetStarDatabase();
    const users = db.collection("Users");

    const user = await users.findOne({ id: parseInt(userId) });
    if (!user) return false;

    const currentGems = user.balances?.[3]?.amount || 0;
    if (currentGems < amount) return false;

    const result = await users.updateOne(
      { id: parseInt(userId) },
      { $inc: { "balances.3.amount": -amount } }
    );

    return result.modifiedCount > 0;
  } catch (error) {
    throw new Error("Erro ao remover gems do usuário: " + error);
  }
}

export async function CheckGems(userId: string, requiredAmount: number): Promise<boolean> {
  try {
    const db = GetStarDatabase();
    const users = db.collection("Users");

    const user = await users.findOne({ id: parseInt(userId) });
    if (!user) return false;

    const currentGems = user.balances?.[3]?.amount || 0;
    return currentGems >= requiredAmount;
  } catch (error) {
    throw new Error("Erro ao verificar gems do usuário: " + error);
  }
}

async function SendWebhook(tournament: any): Promise<void> {
  if (!WEBHOOK_URI) {
    return;
  }

  try {
    const DEFAULT_IMAGE = "";
    if (!tournament.TournamentImage) tournament.TournamentImage = DEFAULT_IMAGE;

    const hexColor = tournament.TournamentColor?.replace("#", "") || "daef20";
    const decimalColor = parseInt(hexColor.substring(0, 6), 16);

    const isFFA = tournament.PartySize === 1 && tournament.MaxPlayersPerMatch > 2;
    const modeText = isFFA
      ? Array(tournament.MaxPlayersPerMatch).fill("1").join("v")
      : `${tournament.PartySize}v${tournament.PartySize}`;

    const disabledEmotes = tournament.Properties?.DisabledEmotes || [];
    const emotesText =
      disabledEmotes.length > 0
        ? disabledEmotes.map((emoteId: number) => getEmoteFriendlyName(emoteId)).join(", ")
        : "All Enabled";

    const signupTimestamp = Math.floor(new Date(tournament.SignupStart).getTime() / 1000);
    const startTimestamp = Math.floor(new Date(tournament.StartTime).getTime() / 1000);

    const prizes: Array<{ position: number; amount: number }> = tournament.Prizes || [];
    const totalPrize = prizes.reduce((sum: number, p: any) => sum + p.amount, 0);
    const prizeListText = prizes.length > 0
      ? prizes.map((p: any) => `#${p.position}: ${p.amount}`).join(" | ")
      : null;

    const components = [
      {
        type: 9,
        components: [
          {
            type: 10,
            content: ``,
          },
        ],
        accessory: {
          type: 11,
          media: {
            url: tournament.TournamentImage,
          },
        },
      },
      {
        type: 14,
      },
      {
        type: 10,
        content: `- Name: **${tournament.TournamentName}**\n- Region: **${
          TournamentRegion[tournament.Region as keyof typeof TournamentRegion]
        }**\n- Tournament Emotes: **${emotesText}**\n- Type: **${modeText}**\n- Max Players: **${
          tournament.MaxInvites
        }**\n- Tournament Phases: **${tournament.Phases?.length || 0}**\n- Sign-ups: **<t:${signupTimestamp}:R>**\n- Start: **<t:${startTimestamp}:R>**`,
      },
      ...(totalPrize > 0 ? [
        {
          type: 14,
        },
        {
          type: 10,
          content: `- Prize Pool: **<:Gems:1444331284716589186> ${totalPrize}**\n- Prizes: *${prizeListText}*`,
        },
      ] : []),
      {
        type: 14,
        divider: true,
      },
      {
        type: 10,
        content: `## <:Sghit:1474846538026188962> - Tournament Matches`,
      },
    ];

    if (tournament.Phases && tournament.Phases.length > 0) {
      tournament.Phases.forEach((phase: any, index: number) => {
        const phaseTypeName = getPhaseTypeName(Number(phase.PhaseType));
        const mapNames =
          phase.Maps && phase.Maps.length > 0
            ? phase.Maps.map((sceneId: string) => getMapFriendlyName(sceneId)).join(", ")
            : "NA";

        let phaseContent = `- Phase ${index + 1}\n`;
        phaseContent += `> Phase Type: **${phaseTypeName}**\n`;
        if (phase.MaxTeams) {
          phaseContent += `> Phase Teams: **${phase.MaxTeams}**\n`;
        }

        phaseContent += `> Phase Maps: **${mapNames}**\n`;

        if (phase.RoundCount) {
          phaseContent += `> Phase Rounds: **${phase.RoundCount}**\n`;
        }

        if (phase.GroupCount && phase.GroupCount > 1) {
          phaseContent += `> Pass Teams Per Group: **${phase.MaxTeams / phase.GroupCount}**\n`;
        }

        components.push({
          type: 10,
          content: phaseContent,
        });

        if (index < tournament.Phases.length - 1) {
          components.push({
            type: 14,
          });
        }
      });
    }

    const payload = {
      type: 0,
      flags: 32768,
      components: [
        {
          type: 17,
          components: components,
          accent_color: decimalColor,
        },
      ],
    };

    const webhookUrl =
      WEBHOOK_URI.replace("https://discord.com/api/webhooks/", "https://discord.com/api/v10/webhooks/") +
      "?wait=true&with_components=true";

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook failed: ${response.status} - ${errorText}`);
    }
  } catch (err) {
    throw err;
  }
}

export async function CreateTournament(tournamentData: TournamentInput) {
  const SignupStart = tournamentData.SignupStart  ?? new Date(tournamentData.StartTime.getTime() - 60 * 60 * 1000);

  const tournament = new Tournament({
    ...tournamentData,
    SignupStart
  });

  const saved = await tournament.save();
  
  await SendWebhook(saved);
  return saved;
}

async function GenerateUserId(): Promise<string> {
  const UsersCollection = BackboneUser.collection;

  let unique = false;
  let userId = "";

  while (!unique) {
    userId = Math.floor(10000 + Math.random() * 90000).toString();
    const exists = await UsersCollection.findOne({ UserId: userId });
    if (!exists) unique = true;
  }

  return userId;
}

export async function CreateSignedUpUser(Times: number, TournamentId: string) {
  const users = [];
  const DBTour = await Tournament.findOne({ TournamentId });

  if (!DBTour) {
    msg("Please provide a valid tournamentid :)");
    return;
  }

  const partySize = DBTour.PartySize;

  for (let i = 0; i < Times / partySize; i++) {
    const partyCode = uuidv4();
    const partyMembers = [];
    const AcceptedAt = new Date();

    for (let j = 0; j < partySize; j++) {
      const UserId = await GenerateUserId();
      const Username = `stumblehit#${Math.random().toString(36).substring(2, 8)}`;
      const IsPartyLeader = j === 0;

      partyMembers.push({
        UserId,
        Username,
        Status: TournamentUserStatus.Confirmed,
        IsPartyLeader,
      });
    }

    for (const member of partyMembers) {
      const user = new BackboneUser({
        Username: member.Username,
        UserId: member.UserId,
        Tournaments: {
          [TournamentId]: {
            SignedUp: true,
            InviteId: GenerateInviteId(),
            Status: TournamentUserStatus.Confirmed,
            AcceptedAt,
            PartyCode: partyCode,
            KnockedOut: false,
            PartyMembers: partyMembers,
            UserMatch: null,
            UserMatches: [],
            UserPosition: [],
            FinalPlace: 0,
          },
        },
      });

      users.push(user.save());
    }
  }

  return await Promise.all(users);
}
