import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { CreateTournament } from "./Database";
import {
  Emotes,
  Scenes,
  Regions,
  EmoteGroupDefinitions,
  SpecialEmotesNames,
  EmoteEmojis,
  TournamentStatus,
} from "../Backbone/Config";
import { GeneratePrizepoolId } from "../Modules/Extensions";
import { Tournament } from "../Models/Tournament";
import { msg } from "../Modules/Logger";
import { TournamentScheduler } from "./Scheduler";
import { GetNextPhaseStarted } from "../Backbone/Settings/Properties";
import { GenerateBracketMatches } from "../Backbone/Logic/GetMatches";
import { BackboneUser } from "../Models/BackboneUser";
import { Match } from "../Models/Matches";
import { TournamentMatchStatus } from "../Backbone/Config";

const AllowedRoleId = process.env.DISCORD_ALLOWED_ROLE_ID || "";

type DateParts = { year: number; month: number; day: number };

export class TournamentBot {
  private static client: Client;
  private static rest: REST;
  private static regionChoices: { name: string; value: string }[];
  private static emoteCombinations: { name: string; value: string }[];
  private static commands: any[];
  private static readonly SAO_PAULO_OFFSET_MS = -3 * 60 * 60 * 1000;
  private static readonly DAY_MS = 24 * 60 * 60 * 1000;

  public static async Start(): Promise<void> {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.rest = new REST({ version: "10" }).setToken(
      process.env.BOT_TOKEN || "01b2b3f7b201ebfb4ae87e6e368ccb7390cb957b5d569777489c1bb77ba22d91"
    );

    this.regionChoices = Object.keys(Regions).map((name) => ({
      name,
      value: Regions[name as keyof typeof Regions],
    }));

    this.emoteCombinations = this.generateEmoteCombinations();
    this.commands = this.buildCommands();

    this.setupEventListeners();

    try {
      await this.client.login(process.env.BOT_TOKEN);
      msg(`logged in as ${this.client.user?.tag}`);
    } catch (error) {
      console.error("setup failed:", error);
      throw error;
    }
  }

  private static generateEmoteCombinations(): {
    name: string;
    value: string;
  }[] {
    const combinations: { name: string; value: string }[] = [];
    const groupKeys = Object.keys(EmoteGroupDefinitions);

    for (let i = 1; i < 1 << groupKeys.length; i++) {
      let mask = 0;
      let names: string[] = [];
      for (let j = 0; j < groupKeys.length; j++) {
        if ((i >> j) & 1) {
          const key = groupKeys[j];
          mask |= EmoteGroupDefinitions[key].mask;
          names.push(key);
        }
      }
      combinations.push({
        name: names.join(" & "),
        value: (-1000 - mask).toString(),
      });
    }

    combinations.sort((a, b) => {
      const countA = a.name.split("&").length;
      const countB = b.name.split("&").length;
      if (countA !== countB) return countA - countB;
      return a.name.localeCompare(b.name);
    });

    combinations.unshift(
      { name: "Disable All Emotes", value: "0" },
      { name: "Special Emotes", value: "-1" }
    );

    return combinations;
  }

  private static normalizeImageUrl(rawUrl: string, size: number = 512): string {
    if (!rawUrl) return rawUrl;
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase();
      const isDiscordCdn =
        host === "cdn.discordapp.com" || host.endsWith(".discordapp.com");
      if (!isDiscordCdn) return rawUrl;
      const currentSize = url.searchParams.get("size");
      if (!currentSize || Number(currentSize) !== size) {
        url.searchParams.set("size", String(size));
      }
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  private static buildCommands(): any[] {
    return [
      new SlashCommandBuilder()
        .setName("create")
        .setDescription("criar torneio")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("nome do torneio")
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("players")
            .setDescription("max jogadores")
            .setRequired(true)
            .setMinValue(8)
            .setMaxValue(1024)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("start")
            .setDescription("comeca em minutos")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("region")
            .setDescription("regiao")
            .setRequired(true)
            .addChoices(...this.regionChoices)
        )
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("tipo de fase")
            .setRequired(true)
            .addChoices(
              { name: "roundrobin", value: "roundrobin" },
              { name: "bracket", value: "bracket" }
            )
        )
        .addIntegerOption((opt) =>
          opt.setName("party").setDescription("tamanho do party").setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("fee").setDescription("taxa de entrada").setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("maps")
            .setDescription("mapas separados por virgula")
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("emotepreset")
            .setDescription("preset de emotes desativados")
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("disabledemotes")
            .setDescription("emotes desativados (nomes ou IDs separados por virgula)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("image").setDescription("url da imagem").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("color").setDescription("cor em hex").setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName("invite").setDescription("somente convite").setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("prizepool").setDescription("valor total do prize pool (opcional, distribui automaticamente)").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("streamurl").setDescription("url da stream (opcional)").setRequired(false)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("schedule")
        .setDescription("agendar criacao e inicio do torneio")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("nome do torneio")
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("players")
            .setDescription("max jogadores")
            .setRequired(true)
            .setMinValue(8)
            .setMaxValue(1024)
        )
        .addStringOption((opt) =>
          opt
            .setName("createat")
            .setDescription("hora de criacao (HH:mm)")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("startat")
            .setDescription("hora de inicio (HH:mm)")
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("signupmins")
            .setDescription("minutos que as inscricoes ficam abertas")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("region")
            .setDescription("regiao")
            .setRequired(true)
            .addChoices(...this.regionChoices)
        )
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("tipo de fase")
            .setRequired(true)
            .addChoices(
              { name: "roundrobin", value: "roundrobin" },
              { name: "bracket", value: "bracket" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("date")
            .setDescription("data (YYYY-MM-DD)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("data")
            .setDescription("data (DD/MM/YY)")
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("party").setDescription("tamanho do party").setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("fee").setDescription("taxa de entrada").setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("maps")
            .setDescription("mapas separados por virgula")
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("emotepreset")
            .setDescription("preset de emotes desativados")
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("disabledemotes")
            .setDescription("emotes desativados (nomes ou IDs separados por virgula)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("image").setDescription("url da imagem").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("color").setDescription("cor em hex").setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt.setName("invite").setDescription("somente convite").setRequired(false)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("start")
        .setDescription("forcar inicio do torneio")
        .addStringOption((opt) =>
          opt.setName("id").setDescription("id").setRequired(true)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("emoteslist")
        .setDescription("listar emotes especiais e ids")
        .toJSON(),

      new SlashCommandBuilder()
        .setName("presets")
        .setDescription("criar torneio por preset")
        .addStringOption((opt) =>
          opt
            .setName("preset")
            .setDescription("nome do preset")
            .setRequired(true)
            .addChoices(
              { name: "1v1 Block Dash Only Punch", value: "1v1_blockdash_punch" },
              { name: "2v2 Block Dash Only Punch", value: "2v2_blockdash_punch" }
            )
        )
        .addStringOption((opt) =>
          opt.setName("name").setDescription("nome do torneio").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("players")
            .setDescription("max jogadores")
            .setRequired(true)
            .setMinValue(8)
            .setMaxValue(1024)
        )
        .addStringOption((opt) =>
          opt
            .setName("region")
            .setDescription("regiao")
            .setRequired(true)
            .addChoices(...this.regionChoices)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("start")
            .setDescription("comeca em minutos")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("image").setDescription("url da imagem").setRequired(false)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("list")
        .setDescription("mostrar torneios")
        .addStringOption((opt) =>
          opt
            .setName("region")
            .setDescription("filtro de regiao")
            .setRequired(false)
            .addChoices(...this.regionChoices)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("status")
            .setDescription("filtro de status")
            .setRequired(false)
            .addChoices(
              { name: "nao iniciado", value: 0 },
              { name: "aberto", value: 1 },
              { name: "fechado", value: 2 },
              { name: "finalizado", value: 3 },
              { name: "cancelado", value: 4 },
              { name: "em andamento", value: 5 }
            )
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("delete")
        .setDescription("excluir torneio")
        .addStringOption((opt) =>
          opt.setName("id").setDescription("id").setRequired(true)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("edit")
        .setDescription("editar torneio")
        .addStringOption((opt) =>
          opt.setName("id").setDescription("id").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("name").setDescription("nome").setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("max").setDescription("max jogadores").setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("fee").setDescription("taxa de entrada").setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("time").setDescription("novo tempo de inicio em minutos a partir de agora").setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("rounds").setDescription("numero de rounds").setRequired(false).setMinValue(1).setMaxValue(20)
        )
        .addStringOption((opt) =>
          opt
            .setName("emotepreset")
            .setDescription("preset de emotes desativados")
            .setRequired(false)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("disabledemotes")
            .setDescription(
              "emotes desativados (nomes separados por virgula) ex: (Punch, Kick)"
            )
            .setRequired(false)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("wo")
        .setDescription("avanca o jogador no round atual (walkover)")
        .addStringOption((opt) =>
          opt.setName("tourid").setDescription("id do torneio").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("playerid").setDescription("id do jogador").setRequired(true)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("invitetour")
        .setDescription("convidar jogadores para torneio privado")
        .addStringOption((opt) =>
          opt.setName("tourid").setDescription("id do torneio").setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("userid")
            .setDescription("ids separados por virgula")
            .setRequired(true)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("resetranking")
        .setDescription("resetar TournamentsWon de todos os jogadores")
        .toJSON(),

      new SlashCommandBuilder()
        .setName("addtorneio")
        .setDescription("adicionar torneios ganhos a um jogador")
        .addStringOption((opt) =>
          opt.setName("userid").setDescription("id do jogador").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("quantidade").setDescription("quantidade a adicionar").setRequired(true).setMinValue(1)
        )
        .toJSON(),

      new SlashCommandBuilder()
        .setName("removertorneio")
        .setDescription("remover torneios ganhos de um jogador")
        .addStringOption((opt) =>
          opt.setName("userid").setDescription("id do jogador").setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt.setName("quantidade").setDescription("quantidade a remover").setRequired(true).setMinValue(1)
        )
        .toJSON(),

    ];
  }

  private static setupEventListeners(): void {
    this.client.once("clientReady", async () => {
      await this.setupCommands();
      msg(`logged in as ${this.client.user?.tag}`);
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
      } else if (interaction.isChatInputCommand()) {
        await this.handleCommand(interaction);
      }
    });
  }

  private static async setupCommands(): Promise<void> {
    const appId = process.env.DISCORD_APP_ID;
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!appId || !guildId) {
      msg("DISCORD_APP_ID or DISCORD_GUILD_ID not set; skipping slash command registration.");
      return;
    }

    try {
      await this.rest.put(
        Routes.applicationGuildCommands(appId, guildId),
        { body: this.commands }
      );
      msg("commands ready");
    } catch (error) {
      console.error("setup failed:", error);
    }
  }

  private static async handleAutocomplete(interaction: any): Promise<void> {
    try {
      if (["create", "schedule", "edit"].includes(interaction.commandName)) {
        const focused = interaction.options.getFocused(true);

        if (focused.name === "maps") {
          const query = String(focused.value || "").toLowerCase();
          const entries = Object.entries(Scenes)
            .filter(([n]) => n.toLowerCase().includes(query))
            .slice(0, 25)
            .map(([name, key]) => ({ name, value: key as string }));
          await interaction.respond(entries);
          return;
        }

        if (focused.name === "emotepreset") {
          const query = String(focused.value || "").toLowerCase();
          const terms = query.split(/[\s,&]+/).filter((t) => t.length > 0);
          const filtered = this.emoteCombinations
            .filter((c) => {
              const nameLower = c.name.toLowerCase();
              if (terms.length === 0) return true;
              return terms.every((t) => nameLower.includes(t));
            })
            .slice(0, 25);
          await interaction.respond(filtered);
          return;
        }
      }
    } catch (error) {}
  }

  private static async handleCommand(interaction: any): Promise<void> {
    if (
      !interaction.inGuild() ||
      !this.memberHasRole(interaction, AllowedRoleId)
    ) {
      await interaction.reply({
        content: "Voce nao tem permissao para usar comandos.",
        ephemeral: true,
      });
      return;
    }

    const cmd = interaction.commandName;
    const user = interaction.user?.tag ?? interaction.user?.id ?? "unknown";
    msg(`[cmd] ${user} usou /${cmd}`);

    switch (cmd) {
      case "create":
        await this.handleCreate(interaction);
        break;
      case "schedule":
        await this.handleSchedule(interaction);
        break;
      case "start":
        await this.handleStart(interaction);
        break;
      case "list":
        await this.handleList(interaction);
        break;
      case "delete":
        await this.handleDelete(interaction);
        break;
      case "edit":
        await this.handleEdit(interaction);
        break;
      case "emoteslist":
        await this.handleEmotesList(interaction);
        break;
      case "presets":
        await this.handlePresets(interaction);
        break;
      case "invitetour":
        await this.handleInviteTour(interaction);
        break;
      case "wo":
        await this.handleWO(interaction);
        break;
      case "resetranking":
        await this.handleResetRanking(interaction);
        break;
      case "addtorneio":
        await this.handleAlterTorneio(interaction, "add");
        break;
      case "removertorneio":
        await this.handleAlterTorneio(interaction, "remove");
        break;
    }
  }

  private static memberHasRole(interaction: any, roleId: string): boolean {
    const member = interaction.member;
    if (!member) return false;

    if (Array.isArray(member.roles)) {
      return member.roles.includes(roleId);
    }

    const roles = member.roles;
    return roles?.cache?.has(roleId) ?? false;
  }

  private static parseEmotes(emotesInput: string): number[] {
    return emotesInput
      .split(",")
      .map((e) => {
        const trimmed = e.trim();
        const emoteId = Emotes[trimmed as keyof typeof Emotes];
        if (emoteId !== undefined) {
          return emoteId;
        }
        const parsed = parseInt(trimmed);
        return isNaN(parsed) ? null : parsed;
      })
      .filter((id): id is number => id !== null);
  }

  private static parseUserIds(raw: string): string[] {
    if (!raw) return [];
    const tokens = raw.split(/[\s,;]+/);
    const unique = new Set<string>();

    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const normalized = trimmed.replace(/[<@!>]/g, "").trim();
      if (normalized) unique.add(normalized);
    }

    return Array.from(unique);
  }

  private static resolveEmotePresetValue(raw: string | null | undefined): number[] {
    if (!raw) return [];
    const trimmed = raw.trim();
    if (!trimmed) return [];

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return [numeric];

    const match = this.emoteCombinations.find(
      (c) => c.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (match) {
      const parsed = Number(match.value);
      if (Number.isFinite(parsed)) return [parsed];
    }

    return [];
  }

  private static getEmoteNames(emoteIds: number[]): string {
    return emoteIds
      .map((id) => {
        if (id === 0) return "All Emotes";
        const name = Object.keys(Emotes).find(
          (key) => Emotes[key as keyof typeof Emotes] === id
        );
        return name || `ID:${id}`;
      })
      .join(", ");
  }

  private static resolveEmbedColor(
    input: string | null | undefined,
    fallback: string
  ): number {
    const raw = (input ?? "").trim();
    const match = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(raw);
    const hex = match ? match[1] : fallback.replace("#", "");
    return parseInt(hex, 16);
  }

  private static calculateBracketRounds(teams: number): number {
    if (!Number.isFinite(teams) || teams <= 1) return 1;
    const rounds = Math.log2(teams);
    if (!Number.isFinite(rounds)) return 1;
    return Math.max(1, Math.round(rounds));
  }

  private static parseTimeOfDay(s: string): { hours: number; minutes: number } {
    const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!match) throw new Error("formato de hora invalido, use HH:mm");

    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);

    if (
      isNaN(hours) ||
      isNaN(minutes) ||
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      throw new Error("hora invalida");
    }

    return { hours, minutes };
  }

  private static parseDateOnly(s?: string): DateParts | null {
    if (!s) return null;

    const raw = s.trim();
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const day = parseInt(match[3], 10);
      if (!this.isValidDateParts(year, month, day)) {
        throw new Error("data invalida");
      }
      return { year, month: month - 1, day };
    }

    match = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(raw);
    if (match) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      let year = parseInt(match[3], 10);
      if (match[3].length === 2) year += 2000;
      if (!this.isValidDateParts(year, month, day)) {
        throw new Error("data invalida");
      }
      return { year, month: month - 1, day };
    }

    throw new Error("formato de data invalido, use YYYY-MM-DD ou DD/MM/YY");
  }

  private static isValidDateParts(
    year: number,
    month: number,
    day: number
  ): boolean {
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return false;
    }

    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;

    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day <= maxDay;
  }

  private static toSaoPauloParts(date: Date): {
    year: number;
    month: number;
    day: number;
    hours: number;
    minutes: number;
  } {
    const sp = new Date(date.getTime() + this.SAO_PAULO_OFFSET_MS);
    return {
      year: sp.getUTCFullYear(),
      month: sp.getUTCMonth(),
      day: sp.getUTCDate(),
      hours: sp.getUTCHours(),
      minutes: sp.getUTCMinutes(),
    };
  }

  private static buildSaoPauloDate(
    dateParts: DateParts,
    timeOfDay: { hours: number; minutes: number }
  ): Date {
    const utcMs =
      Date.UTC(
        dateParts.year,
        dateParts.month,
        dateParts.day,
        timeOfDay.hours,
        timeOfDay.minutes,
        0,
        0
      ) - this.SAO_PAULO_OFFSET_MS;

    return new Date(utcMs);
  }

  private static async handleEmotesList(interaction: any): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });

      const lines = SpecialEmotesNames.map((name) => {
        const id = Emotes[name];
        const emoji = EmoteEmojis?.[name as keyof typeof EmoteEmojis];
        const prefix = emoji ? `${emoji} ` : "";
        return `${prefix}${name} - ${id}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("emotes especiais")
        .setColor(0xf81616)
        .setDescription(lines.join("\n"))
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("emoteslist error:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await interaction.editReply({ content: `falhou: ${errorMessage}` });
    }
  }

  private static getPresetConfig(
    presetKey: string
  ): { name: string; party: number; maps: string[]; disabledEmotes: number[] } | null {
    const blockDashMap = Scenes["Block Dash"] || "level19_block";
    const punchOnly = Emotes["Punch Only"];
    if (punchOnly == null) return null;
    const base = {
      maps: [blockDashMap],
      disabledEmotes: [punchOnly],
    };

    switch (presetKey) {
      case "1v1_blockdash_punch":
        return { name: "1v1 Block Dash Only Punch", party: 1, ...base };
      case "2v2_blockdash_punch":
        return { name: "2v2 Block Dash Only Punch", party: 2, ...base };
      default:
        return null;
    }
  }

  private static async handlePresets(interaction: any): Promise<void> {
    try {
      const deferred = await this.safeDefer(interaction, "presets");
      if (!deferred) return;

      const presetKey = interaction.options.getString("preset", true);
      const tournamentName = interaction.options.getString("name", true);
      const max = interaction.options.getInteger("players", true);
      const startMinutes = interaction.options.getInteger("start") || 10;
      const region = interaction.options.getString("region", true);
      const img =
        interaction.options.getString("image") ||
        "https://cdn.discordapp.com/icons/1438984311373172748/e229d29ee50d2819e6bfa94192e39a3e.png?size=2048?ex=697adede&is=69798d5e&hm=e01013b73567b4edc185f8d12e4c415d15c9728f80737b7fceeb27ef73d697cd";

      const preset = this.getPresetConfig(presetKey);
      if (!preset) {
        await this.safeEditReply(
          interaction,
          { content: "preset invalido" },
          "presets"
        );
        return;
      }

      const party = preset.party;
      const maps = preset.maps;
      const disabledEmotes = preset.disabledEmotes;
      const phaseType = 2;
      const rounds = this.calculateBracketRounds(max);
      const computedMaxTeams = max;
      const computedMaxInvites = max * party;
      const fee = 0;

      const prizes = this.calculatePrizes(fee, computedMaxInvites, party);
      const totalPrize = prizes.reduce((sum, prize) => sum + prize.amount, 0);

      const phases = [
        {
          PhaseType: phaseType,
          IsPhase: false,
          RoundCount: rounds,
          MaxTeams: computedMaxTeams,
          GroupCount: 1,
          Maps: maps,
        },
      ];

      const id = Date.now().toString();
      const startTime = new Date(Date.now() + startMinutes * 60000);
      const existingType1 = await Tournament.exists({ TournamentType: 1 });
      const tournamentType = existingType1 ? 2 : 1;

      const normalizedImg = this.normalizeImageUrl(img);

      await CreateTournament({
        CurrentInvites: 0,
        MaxInvites: computedMaxInvites,
        TournamentId: id,
        TournamentName: tournamentName,
        TournamentImage: normalizedImg,
        TournamentColor: "#008cffff",
        StartTime: startTime,
        SignupStart: new Date(),
        EntryFee: fee,
        PrizepoolId: GeneratePrizepoolId().toString(),
        PartySize: party,
        Status: 1,
        TournamentType: tournamentType,
        Phases: phases,
        Region: region,
        RoundCount: rounds,
        CurrentPhaseId: 0,
        MinPlayersPerMatch: 2,
        MaxPlayersPerMatch: 2,
        Prizes: prizes,
        Properties: {
          IsInvitationOnly: false,
          InvitedIds: [],
          DisabledEmotes: disabledEmotes,
          AdminIds: [],
          StreamURL: "https://discord.gg/.gg/stumblenext",
        },
      });

      const embed = new EmbedBuilder()
        .setTitle("criado")
        .setColor(0xee1313)
        .setDescription(`**${tournamentName}**`)
        .addFields(
          { name: "id", value: `\`${id}\``, inline: false },
          { name: "preset", value: preset.name, inline: true },
          { name: "max", value: computedMaxInvites.toString(), inline: true },
          { name: "party", value: party.toString(), inline: true },
          { name: "regiao", value: region.toUpperCase(), inline: true },
          { name: "tipo", value: "bracket", inline: true },
          { name: "rodadas", value: rounds.toString(), inline: true },
          {
            name: "premiacao total",
            value: `$${totalPrize.toLocaleString()}`,
            inline: true,
          },
          { name: "premios", value: `${prizes.length} posicoes`, inline: true },
          {
            name: "comeca",
            value: `<t:${Math.floor(startTime.getTime() / 1000)}:R>`,
            inline: false,
          }
        )
        .setTimestamp();

      if (disabledEmotes.length > 0) {
        embed.addFields({
          name: "emotes desativados",
          value: this.getEmoteNames(disabledEmotes),
          inline: false,
        });
      }

      await this.safeEditReply(interaction, { embeds: [embed] }, "presets");
    } catch (error) {
      console.error("presets error:", error);
      await this.safeEditReply(
        interaction,
        {
          content: `falhou: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        "presets"
      );
    }
  }

  private static nextOccurrence(
    baseDate: DateParts | null,
    timeOfDay: { hours: number; minutes: number }
  ): Date {
    const now = new Date();
    const day =
      baseDate ??
      (() => {
        const sp = this.toSaoPauloParts(now);
        return { year: sp.year, month: sp.month, day: sp.day };
      })();
    let target = this.buildSaoPauloDate(day, timeOfDay);

    if (target.getTime() <= now.getTime()) {
      target = new Date(target.getTime() + this.DAY_MS);
    }

    return target;
  }

  private static async safeDefer(
    interaction: any,
    label: string
  ): Promise<boolean> {
    try {
      await interaction.deferReply({ ephemeral: true });
      return true;
    } catch (error) {
      console.error(`${label} defer failed:`, error);
      return false;
    }
  }

  private static async safeEditReply(
    interaction: any,
    payload: any,
    label: string
  ): Promise<void> {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
        return;
      }

      await interaction.reply({ ...payload, ephemeral: true });
    } catch (error) {
      console.error(`${label} reply failed:`, error);
    }
  }

  private static async sendLog(embed: EmbedBuilder): Promise<void> {
    const uri = process.env.LOG_WEBHOOK_URI || "";
    if (!uri) return;
    try {
      const res = await fetch(uri, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed.toJSON()] }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`sendLog failed: ${res.status} - ${text}`);
      }
    } catch (error) {
      console.error("sendLog failed:", error);
    }
  }

  private static calculatePrizes(
    entryFee: number,
    maxInvites: number,
    partySize: number
  ): Array<{ amount: number; position: number }> {
    const rawPrize = entryFee * maxInvites * partySize;

    if (rawPrize <= 0) return [];

    const log2 = Math.floor(Math.log2(rawPrize));
    const prizePool = Math.pow(2, log2);

    const prizes: Array<{ amount: number; position: number }> = [];
    let remaining = prizePool;
    let position = 1;

    while (remaining > 0 && position <= maxInvites) {
      const prize = Math.pow(2, Math.floor(Math.log2(remaining)));
      prizes.push({ amount: prize, position: position });
      remaining -= prize;
      position++;
    }

    return prizes;
  }

  private static distributePrizepool(
    total: number,
    maxTeams: number
  ): Array<{ amount: number; position: number }> {
    if (total <= 0 || maxTeams <= 0) return [];

    const prizeSlots = Math.max(1, Math.floor(maxTeams / 2));

    // pesos decrescentes: 1o tem peso N, ultimo tem peso 1
    const weights: number[] = [];
    for (let i = prizeSlots; i >= 1; i--) weights.push(i);
    const weightSum = weights.reduce((a, b) => a + b, 0);

    const prizes: Array<{ amount: number; position: number }> = [];
    let distributed = 0;

    for (let i = 0; i < prizeSlots; i++) {
      const isLast = i === prizeSlots - 1;
      const amount = isLast
        ? total - distributed
        : Math.floor((weights[i] / weightSum) * total);
      prizes.push({ position: i + 1, amount });
      distributed += amount;
    }

    return prizes;
  }

  private static async handleCreate(interaction: any): Promise<void> {
    try {
      const deferred = await this.safeDefer(interaction, "create");
      if (!deferred) return;

      const name = interaction.options.getString("name", true);
      const max = interaction.options.getInteger("players", true);
      const startMinutes = interaction.options.getInteger("start", true);
      const region = interaction.options.getString("region", true);
      const typeStr = interaction.options.getString("type", true);
      const party = interaction.options.getInteger("party") || 2;
      const fee = interaction.options.getInteger("fee") || 0;
      const mapsInput = interaction.options.getString("maps") || "Block Dash";
      const emotePreset = interaction.options.getString("emotepreset");
      const disabledEmotesInput =
        interaction.options.getString("disabledemotes");
      const img =
        interaction.options.getString("image") ||
        "https://cdn.discordapp.com/icons/1438984311373172748/e229d29ee50d2819e6bfa94192e39a3e.png?size=2048?ex=697adede&is=69798d5e&hm=e01013b73567b4edc185f8d12e4c415d15c9728f80737b7fceeb27ef73d697cd";
      const color = interaction.options.getString("color") || "#ee1313ff";
      const embedColor = this.resolveEmbedColor(color, "#ee1313");
      const inviteOnly = interaction.options.getBoolean("invite") || false;
      const prizepoolAmount = interaction.options.getInteger("prizepool") || 0;
      const streamUrl = interaction.options.getString("streamurl") || "";
      const normalizedImg = this.normalizeImageUrl(img);

      const phaseType = typeStr === "bracket" ? 2 : 3;

      const maps = mapsInput
        .split(/[;,]/)
        .map((m) => {
          const trimmed = m.trim();
          return Scenes[trimmed as keyof typeof Scenes] || trimmed;
        })
        .filter(Boolean);

      const computedMaxTeams = max;
      const computedMaxInvites = max * party;
      const rounds = phaseType === 2 ? this.calculateBracketRounds(max) : 10;

      // se prizepool foi informado, distribui pelo numero de times; senao calcula pela taxa
      const prizes = prizepoolAmount > 0
        ? this.distributePrizepool(prizepoolAmount, computedMaxTeams)
        : this.calculatePrizes(fee, computedMaxInvites, party);
      const totalPrize = prizes.reduce((sum, prize) => sum + prize.amount, 0);

      let disabledEmotes: number[] = [];
      if (emotePreset) {
        disabledEmotes = this.resolveEmotePresetValue(emotePreset);
        if (disabledEmotes.length === 0) {
          throw new Error("emotepreset invalido, selecione um preset valido");
        }
      } else if (disabledEmotesInput) {
        disabledEmotes = this.parseEmotes(disabledEmotesInput);
      }

      const phases = [
        {
          PhaseType: phaseType,
          IsPhase: phaseType === 3,
          RoundCount: rounds,
          MaxTeams: computedMaxTeams,
          GroupCount: 1,
          Maps: maps,
        },
      ];

      const id = Date.now().toString();
      const startTime = new Date(Date.now() + startMinutes * 60000);
      const existingType1 = await Tournament.exists({ TournamentType: 1 });
      const tournamentType = existingType1 ? 2 : 1;

      await CreateTournament({
        CurrentInvites: 0,
        MaxInvites: computedMaxInvites,
        TournamentId: id,
        TournamentName: name,
        TournamentImage: normalizedImg,
        TournamentColor: color,
        StartTime: startTime,
        SignupStart: new Date(),
        EntryFee: fee,
        PrizepoolId: GeneratePrizepoolId().toString(),
        PartySize: party,
        Status: 1,
        TournamentType: tournamentType,
        Phases: phases,
        Region: region,
        RoundCount: rounds,
        CurrentPhaseId: 0,
        MinPlayersPerMatch: 2,
        MaxPlayersPerMatch: 2,
        Prizes: prizes,
        Properties: {
          IsInvitationOnly: inviteOnly,
          InvitedIds: [],
          DisabledEmotes: disabledEmotes,
          AdminIds: [],
          StreamURL: "",
        },
      });

      const embed = new EmbedBuilder()
        .setTitle("criado")
        .setColor(embedColor)
        .setDescription(`**${name}**`)
        .addFields(
          { name: "id", value: `\`${id}\``, inline: false },
          { name: "max", value: computedMaxInvites.toString(), inline: true },
          { name: "party", value: party.toString(), inline: true },
          { name: "regiao", value: region.toUpperCase(), inline: true },
          { name: "tipo", value: typeStr, inline: true },
          { name: "rodadas", value: rounds.toString(), inline: true },
          { name: "taxa", value: fee.toString(), inline: true },
          {
            name: "premiacao total",
            value: `$${totalPrize.toLocaleString()}`,
            inline: true,
          },
          { name: "premios", value: `${prizes.length} posicoes`, inline: true },
          { name: "fases", value: phases.length.toString(), inline: true },
          {
            name: "comeca",
            value: `<t:${Math.floor(startTime.getTime() / 1000)}:R>`,
            inline: false,
          }
        )
        .setTimestamp();

      if (prizes.length > 0) {
        let prizeList = prizes
          .slice(0, 5)
          .map((p) => `#${p.position}: $${p.amount.toLocaleString()}`)
          .join("\n");
        if (prizes.length > 5)
          prizeList += `\n...e mais ${prizes.length - 5}`;
        embed.addFields({
          name: "principais premios",
          value: prizeList,
          inline: false,
        });
      }

      if (disabledEmotes.length > 0) {
        embed.addFields({
          name: "emotes desativados",
          value: this.getEmoteNames(disabledEmotes),
          inline: false,
        });
      }

      if (streamUrl) {
        embed.addFields({ name: "stream", value: streamUrl, inline: false });
      }

      if (img) embed.setThumbnail(img);

      await this.sendLog(new EmbedBuilder()
        .setTitle("torneio criado")
        .setColor(embedColor)
        .setDescription(`**${name}** por ${interaction.user?.tag ?? interaction.user?.id ?? "unknown"}`)
        .addFields(
          { name: "id", value: `\`${id}\``, inline: true },
          { name: "max", value: computedMaxInvites.toString(), inline: true },
          { name: "regiao", value: region.toUpperCase(), inline: true },
          { name: "prizepool", value: totalPrize > 0 ? totalPrize.toLocaleString() : "nenhum", inline: true },
        )
        .setTimestamp()
      );

      await this.safeEditReply(interaction, { embeds: [embed] }, "create");

    } catch (error) {
      console.error("create error:", error);
      await this.safeEditReply(
        interaction,
        {
          content: `falhou: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        "create"
      );
    }
  }

  private static async handleSchedule(interaction: any): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString("name", true);
      const max = interaction.options.getInteger("players", true);
      const createAtStr = interaction.options.getString("createat", true);
      const startAtStr = interaction.options.getString("startat", true);
      const signupDuration = interaction.options.getInteger("signupmins", true);
      const dateStr =
        interaction.options.getString("data") ??
        interaction.options.getString("date") ??
        undefined;
      const region = interaction.options.getString("region", true);
      const typeStr = interaction.options.getString("type", true);
      const party = interaction.options.getInteger("party") || 2;
      const fee = interaction.options.getInteger("fee") || 0;
      const mapsInput = interaction.options.getString("maps") || "Block Dash";
      const emotePreset = interaction.options.getString("emotepreset");
      const disabledEmotesInput =
        interaction.options.getString("disabledemotes");
      const img =
        interaction.options.getString("image") ||
        "https://cdn.discordapp.com/icons/1438984311373172748/e229d29ee50d2819e6bfa94192e39a3e.png?size=2048?ex=697adede&is=69798d5e&hm=e01013b73567b4edc185f8d12e4c415d15c9728f80737b7fceeb27ef73d697cd";
      const color = interaction.options.getString("color") || "#ef2020ff";
      const embedColor = this.resolveEmbedColor(color, "#ef2020");
      const inviteOnly = interaction.options.getBoolean("invite") || false;
      const streamUrl = interaction.options.getString("streamurl") || "";

      const phaseType = typeStr === "bracket" ? 2 : 3;

      const maps = mapsInput
        .split(/[;,]/)
        .map((m) => {
          const trimmed = m.trim();
          return Scenes[trimmed as keyof typeof Scenes] || trimmed;
        })
        .filter(Boolean);

      const computedMaxTeams = max;
      const computedMaxInvites = max * party;
      const rounds = phaseType === 2 ? this.calculateBracketRounds(max) : 10;

      let disabledEmotes: number[] = [];
      if (emotePreset) {
        disabledEmotes = this.resolveEmotePresetValue(emotePreset);
        if (disabledEmotes.length === 0) {
          throw new Error("emotepreset invalido, selecione um preset valido");
        }
      } else if (disabledEmotesInput) {
        disabledEmotes = this.parseEmotes(disabledEmotesInput);
      }

      const phases = [
        {
          PhaseType: phaseType,
          IsPhase: phaseType === 3,
          RoundCount: rounds,
          MaxTeams: computedMaxTeams,
          GroupCount: 1,
          Maps: maps,
        },
      ];

      const createTOD = this.parseTimeOfDay(createAtStr);
      const startTOD = this.parseTimeOfDay(startAtStr);
      const baseDate = this.parseDateOnly(dateStr);
      const creationDate = this.nextOccurrence(baseDate, createTOD);

      const creationParts = this.toSaoPauloParts(creationDate);
      let startAbs = this.buildSaoPauloDate(
        {
          year: creationParts.year,
          month: creationParts.month,
          day: creationParts.day,
        },
        startTOD
      );
      if (startAbs.getTime() < creationDate.getTime()) {
        startAbs = new Date(startAbs.getTime() + this.DAY_MS);
      }

      const signupAbs = new Date(startAbs.getTime() - signupDuration * 60000);
      if (signupAbs.getTime() < creationDate.getTime()) {
        throw new Error(
          "signupmins maior que o intervalo entre criacao e inicio"
        );
      }

      const tournamentStartMinutes = Math.round(
        (startAbs.getTime() - creationDate.getTime()) / 60000
      );
      const signupStartMinutes = Math.round(
        (signupAbs.getTime() - creationDate.getTime()) / 60000
      );

      const existingType1 = await Tournament.exists({ TournamentType: 1 });
      const tournamentType = existingType1 ? 2 : 1;

      const template = {
        CurrentInvites: 0,
        MaxInvites: computedMaxInvites,
        TournamentId: Date.now().toString(),
        TournamentName: name,
        TournamentImage: img,
        TournamentColor: color,
        StartTime: new Date(),
        SignupStart: new Date(),
        EntryFee: fee,
        PrizepoolId: GeneratePrizepoolId().toString(),
        PartySize: party,
        Status: 1,
        TournamentType: tournamentType,
        Phases: phases,
        Region: region,
        RoundCount: rounds,
        CurrentPhaseId: 0,
        MinPlayersPerMatch: 2,
        MaxPlayersPerMatch: 2,
        Properties: {
          IsInvitationOnly: inviteOnly,
          InvitedIds: [],
          DisabledEmotes: disabledEmotes,
          AdminIds: [],
          StreamURL: streamUrl,
        },
      };

      const scheduleId = await TournamentScheduler.ScheduleOnce(
        template as any,
        creationDate,
        {
          signupStartMinutes,
          tournamentStartMinutes,
        }
      );

      const embed = new EmbedBuilder()
        .setTitle("agendado")
        .setColor(embedColor)
        .setDescription(`**${name}**`)
        .addFields(
          { name: "id do agendamento", value: `\`${scheduleId}\``, inline: false },
          { name: "max", value: computedMaxInvites.toString(), inline: true },
          { name: "party", value: party.toString(), inline: true },
          { name: "regiao", value: region.toUpperCase(), inline: true },
          { name: "tipo", value: typeStr, inline: true },
          { name: "rodadas", value: rounds.toString(), inline: true },
          { name: "taxa", value: fee.toString(), inline: true },
          { name: "fases", value: phases.length.toString(), inline: true },
          {
            name: "cria",
            value: `<t:${Math.floor(creationDate.getTime() / 1000)}:F>`,
            inline: false,
          },
          {
            name: "comeca",
            value: `<t:${Math.floor(startAbs.getTime() / 1000)}:F>`,
            inline: false,
          },
          {
            name: "inscricoes abrem",
            value: `<t:${Math.floor(signupAbs.getTime() / 1000)}:F>`,
            inline: false,
          }
        )
        .setTimestamp();

      if (disabledEmotes.length > 0) {
        embed.addFields({
          name: "emotes desativados",
          value: this.getEmoteNames(disabledEmotes),
          inline: false,
        });
      }

      if (img) embed.setThumbnail(img);

      await this.sendLog(new EmbedBuilder()
        .setTitle("torneio agendado")
        .setColor(embedColor)
        .setDescription(`**${name}** por ${interaction.user?.tag ?? interaction.user?.id ?? "unknown"}`)
        .addFields(
          { name: "id agendamento", value: `\`${scheduleId}\``, inline: true },
          { name: "regiao", value: region.toUpperCase(), inline: true },
          { name: "cria", value: `<t:${Math.floor(creationDate.getTime() / 1000)}:F>`, inline: false },
          { name: "comeca", value: `<t:${Math.floor(startAbs.getTime() / 1000)}:F>`, inline: false },
        )
        .setTimestamp()
      );

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("schedule error:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await interaction.editReply({ content: `falhou: ${errorMessage}` });
    }
  }

  private static async handleStart(interaction: any): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });

      const id = interaction.options.getString("id", true);
      const tournament = await Tournament.findOne({ TournamentId: id });

      if (!tournament) {
        await interaction.editReply({ content: "nao encontrado" });
        return;
      }

      if (tournament.Status === TournamentStatus.Finished) {
        await interaction.editReply({ content: "torneio finalizado" });
        return;
      }

      if (tournament.Status === TournamentStatus.Canceled) {
        await interaction.editReply({ content: "torneio cancelado" });
        return;
      }

      const now = new Date();
      const nextMs = await GetNextPhaseStarted(tournament, 1);
      const nextPhase = new Date(now.getTime() + nextMs);
      const signupStart = new Date(now.getTime() - 60000);

      await Tournament.updateOne(
        { TournamentId: id },
        {
          $set: {
            StartTime: now,
            SignupStart: signupStart,
            Status: TournamentStatus.Running,
            CurrentPhaseId: 1,
            CurrentPhaseStarted: now,
            NextPhaseStarted: nextPhase,
          },
        }
      );

      const updated = await Tournament.findOne({ TournamentId: id });
      if (updated) {
        await GenerateBracketMatches(updated);
      }

      const embed = new EmbedBuilder()
        .setTitle("iniciado")
        .setColor(0x43b581)
        .setDescription(`torneio \`${id}\` iniciado`)
        .addFields(
          { name: "inicio", value: `<t:${Math.floor(now.getTime() / 1000)}:F>`, inline: false },
          { name: "fase", value: "1", inline: true }
        )
        .setTimestamp();

      await this.sendLog(new EmbedBuilder()
        .setTitle("torneio iniciado")
        .setColor(0x43b581)
        .setDescription(`\`${id}\` por ${interaction.user?.tag ?? interaction.user?.id ?? "unknown"}`)
        .addFields({ name: "inicio", value: `<t:${Math.floor(now.getTime() / 1000)}:F>`, inline: false })
        .setTimestamp()
      );

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("start error:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await interaction.editReply({ content: `falhou: ${errorMessage}` });
    }
  }

  private static async handleList(interaction: any): Promise<void> {
    try {
      const regionFilter = interaction.options.getString("region");
      const statusFilter = interaction.options.getInteger("status");

      const query: any = {};
      if (regionFilter) query.Region = regionFilter;
      if (statusFilter !== null) query.Status = statusFilter;

      const tournaments = await Tournament.find(query)
        .limit(10)
        .sort({ StartTime: 1 });

      if (!tournaments.length) {
        await interaction.reply({ content: "nenhum torneio", ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("torneios")
        .setDescription(`mostrando ${tournaments.length}`)
        .setColor(0xf81616)
        .setTimestamp();

      for (const tournament of tournaments) {
        const timestamp = Math.floor(
          new Date(tournament.StartTime).getTime() / 1000
        );
        let status = "desconhecido";

        switch (tournament.Status) {
          case 1:
            status = "aberto";
            break;
          case 2:
            status = "fechado";
            break;
          case 5:
            status = "em andamento";
            break;
          default:
            status = "finalizado";
        }

        const disabledEmotesText =
          tournament.Properties?.DisabledEmotes?.length > 0
            ? `\nemotes desativados: ${this.getEmoteNames(
                tournament.Properties.DisabledEmotes
              )}`
            : "";

        embed.addFields({
          name: `${tournament.TournamentName} [${status}]`,
          value: `id: \`${tournament.TournamentId}\`\njogadores: ${tournament.CurrentInvites}/${tournament.MaxInvites}\nregiao: ${tournament.Region} | taxa: ${tournament.EntryFee}\ncomeca: <t:${timestamp}:R>${disabledEmotesText}`,
          inline: false,
        });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
      console.error("list error:", error);
      await interaction.reply({ content: "falhou", ephemeral: true });
    }
  }

  private static async handleDelete(interaction: any): Promise<void> {
    try {
      const id = interaction.options.getString("id", true);
      const result = await Tournament.deleteOne({ TournamentId: id });

      if (result.deletedCount === 0) {
        await interaction.reply({ content: "nao encontrado", ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("excluido")
        .setDescription(`excluido \`${id}\``)
        .setColor("#ff4444")
        .setTimestamp();

      const user = interaction.user?.tag ?? interaction.user?.id ?? "unknown";
      const logEmbed = new EmbedBuilder()
        .setTitle("torneio excluido")
        .setColor("#ff4444")
        .addFields({ name: "id", value: `\`${id}\``, inline: true }, { name: "por", value: user, inline: true })
        .setTimestamp();
      await this.sendLog(logEmbed);

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
      console.error("delete error:", error);
      await interaction.reply({ content: "falhou", ephemeral: true });
    }
  }

  private static async handleEdit(interaction: any): Promise<void> {
    try {
      const id = interaction.options.getString("id", true);
      const updates: any = {};

      const name = interaction.options.getString("name");
      const max = interaction.options.getInteger("max");
      const fee = interaction.options.getInteger("fee");
      const time = interaction.options.getInteger("time");
      const rounds = interaction.options.getInteger("rounds");
      const emotePreset = interaction.options.getString("emotepreset");
      const disabledEmotesInput = interaction.options.getString("disabledemotes");

      if (name) updates.TournamentName = name;
      if (max) updates.MaxInvites = max;
      if (fee !== null) updates.EntryFee = fee;

      if (time !== null) {
        const newStartTime = new Date(Date.now() + time * 60000);
        updates.StartTime = newStartTime;
      }

      if (rounds !== null) {
        updates.RoundCount = rounds;
        updates["Phases.0.RoundCount"] = rounds;
      }

      if (emotePreset) {
        const presetValues = this.resolveEmotePresetValue(emotePreset);
        if (presetValues.length === 0) {
          throw new Error("emotepreset invalido, selecione um preset valido");
        }
        updates["Properties.DisabledEmotes"] = presetValues;
      } else if (disabledEmotesInput) {
        updates["Properties.DisabledEmotes"] = this.parseEmotes(disabledEmotesInput);
      }

      if (Object.keys(updates).length === 0) {
        await interaction.reply({ content: "sem alteracoes", ephemeral: true });
        return;
      }

      const result = await Tournament.updateOne(
        { TournamentId: id },
        { $set: updates }
      );

      if (result.matchedCount === 0) {
        await interaction.reply({ content: "nao encontrado", ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("atualizado")
        .setDescription(`atualizado \`${id}\``)
        .setColor("#43b581")
        .setTimestamp();

      for (const [key, value] of Object.entries(updates)) {
        if (key === "Properties.DisabledEmotes" && Array.isArray(value)) {
          embed.addFields({
            name: "emotes desativados",
            value: this.getEmoteNames(value),
            inline: true,
          });
        } else if (key === "StartTime" && value instanceof Date) {
          embed.addFields({
            name: "novo inicio",
            value: `<t:${Math.floor((value as Date).getTime() / 1000)}:R>`,
            inline: true,
          });
        } else if (key === "Phases.0.RoundCount") {
          // skip, already shown via RoundCount
        } else {
          embed.addFields({
            name: key,
            value: String(value),
            inline: true,
          });
        }
      }

      const user = interaction.user?.tag ?? interaction.user?.id ?? "unknown";
      await this.sendLog(new EmbedBuilder()
        .setTitle("torneio editado")
        .setColor("#43b581")
        .setDescription(`\`${id}\` por ${user}`)
        .addFields(...embed.data.fields ?? [])
        .setTimestamp()
      );

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
      console.error("edit error:", error);
      await interaction.reply({ content: "falhou", ephemeral: true });
    }
  }

  private static async handleInviteTour(interaction: any): Promise<void> {
    try {
      const deferred = await this.safeDefer(interaction, "invitetour");
      if (!deferred) return;

      const tournamentId = interaction.options.getString("tourid", true);
      const userIdsRaw = interaction.options.getString("userid", true);
      const userIds = this.parseUserIds(userIdsRaw);

      if (!userIds.length) {
        await this.safeEditReply(
          interaction,
          { content: "nenhum userid valido informado" },
          "invitetour"
        );
        return;
      }

      const tournament = await Tournament.findOne({ TournamentId: tournamentId });
      if (!tournament) {
        await this.safeEditReply(
          interaction,
          { content: "torneio nao encontrado" },
          "invitetour"
        );
        return;
      }

      const invitedIds = tournament.Properties?.InvitedIds || [];
      const existing = new Set(invitedIds.map((id) => String(id)));
      const toAdd = userIds.filter((id) => !existing.has(id));
      const already = userIds.filter((id) => existing.has(id));

      if (toAdd.length > 0) {
        await Tournament.updateOne(
          { TournamentId: tournamentId },
          { $addToSet: { "Properties.InvitedIds": { $each: toAdd } } }
        );
      }

      const totalInvited = existing.size + toAdd.length;
      const embed = new EmbedBuilder()
        .setTitle("convites atualizados")
        .setColor(0x43b581)
        .setDescription(`torneio \`${tournamentId}\` atualizado`)
        .addFields(
          { name: "adicionados", value: toAdd.length.toString(), inline: true },
          { name: "ja convidados", value: already.length.toString(), inline: true },
          { name: "total convidados", value: totalInvited.toString(), inline: true }
        )
        .setTimestamp();

      if (!tournament.Properties?.IsInvitationOnly) {
        embed.addFields({
          name: "aviso",
          value: "torneio nao esta como somente convite",
          inline: false,
        });
      }

      if (toAdd.length > 0 && toAdd.length <= 10) {
        embed.addFields({
          name: "ids adicionados",
          value: toAdd.join(", "),
          inline: false,
        });
      }

      await this.safeEditReply(interaction, { embeds: [embed] }, "invitetour");
    } catch (error) {
      console.error("invitetour error:", error);
      await this.safeEditReply(
        interaction,
        { content: "falhou" },
        "invitetour"
      );
    }
  }

  private static async handleWO(interaction: any): Promise<void> {
    try {
      const deferred = await this.safeDefer(interaction, "wo");
      if (!deferred) return;

      const tournamentId = interaction.options.getString("tourid", true);
      const playerId = interaction.options.getString("playerid", true);

      const [tournament, user] = await Promise.all([
        Tournament.findOne({ TournamentId: tournamentId }),
        BackboneUser.findOne({ UserId: playerId }),
      ]);

      if (!tournament) {
        await this.safeEditReply(interaction, { content: "torneio nao encontrado" }, "wo");
        return;
      }
      if (!user) {
        await this.safeEditReply(interaction, { content: "jogador nao encontrado" }, "wo");
        return;
      }

      const tournamentData = user.Tournaments.get(tournamentId);
      if (!tournamentData?.SignedUp) {
        await this.safeEditReply(interaction, { content: "jogador nao inscrito neste torneio" }, "wo");
        return;
      }
      if (!tournamentData.UserMatch) {
        await this.safeEditReply(interaction, { content: "jogador nao tem match ativa" }, "wo");
        return;
      }

      const activeMatch = await Match.findOne({ id: tournamentData.UserMatch.id });
      if (!activeMatch) {
        await this.safeEditReply(interaction, { content: "nenhuma match ativa encontrada para este jogador" }, "wo");
        return;
      }

      const roundId = activeMatch.roundid;
      const matchId = activeMatch.id;
      const phaseId = tournament.CurrentPhaseId || 1;

      // Marca o player como vencedor na match sem alterar o oponente
      const playerTeamId = activeMatch.users.find((u: any) => u["@user-id"] === playerId)?.["@team-id"];
      if (playerTeamId) {
        for (const u of activeMatch.users) {
          if (u["@team-id"] === playerTeamId) {
            u["@match-winner"] = "1";
            u["@match-points"] = "1";
            u["@team-score"] = "1";
          }
          // oponente NÃO é tocado — sem KnockedOut, sem alterar seus dados
        }
      }

      // Fecha a match
      activeMatch.status = TournamentMatchStatus.Closed;
      await activeMatch.save();

      const matchCopy = {
        id: activeMatch.id,
        secret: activeMatch.secret,
        deadline: activeMatch.deadline,
        matchid: activeMatch.matchid,
        phaseid: activeMatch.phaseid,
        groupid: activeMatch.groupid,
        roundid: activeMatch.roundid,
        playedgamecount: activeMatch.playedgamecount,
        status: activeMatch.status,
        tournamentid: activeMatch.tournamentid,
        users: activeMatch.users,
      };

      // Busca próxima match do player no próximo round
      const nextRound = roundId + 1;
      const nextMatch = await Match.findOne({
        tournamentid: tournamentId,
        phaseid: phaseId,
        roundid: nextRound,
        groupid: activeMatch.groupid,
        "users.@user-id": playerId,
        status: { $nin: [TournamentMatchStatus.Closed, TournamentMatchStatus.GameFinished] },
      }).lean();

      const nextMatchCopy = nextMatch ? {
        id: nextMatch.id,
        secret: nextMatch.secret,
        deadline: nextMatch.deadline,
        matchid: nextMatch.matchid,
        phaseid: nextMatch.phaseid,
        groupid: nextMatch.groupid,
        roundid: nextMatch.roundid,
        playedgamecount: nextMatch.playedgamecount,
        status: nextMatch.status,
        tournamentid: nextMatch.tournamentid,
        users: nextMatch.users,
      } : null;

      // Atualiza o player: move match atual para histórico, seta próxima match
      await BackboneUser.updateOne(
        { UserId: playerId, [`Tournaments.${tournamentId}`]: { $exists: true } },
        {
          $set: { [`Tournaments.${tournamentId}.UserMatch`]: nextMatchCopy },
          $push: { [`Tournaments.${tournamentId}.UserMatches`]: matchCopy },
        }
      );

      const executor = interaction.user?.tag ?? interaction.user?.id ?? "unknown";
      const embed = new EmbedBuilder()
        .setTitle("wo aplicado")
        .setColor(0x43b581)
        .addFields(
          { name: "torneio", value: `\`${tournamentId}\``, inline: true },
          { name: "jogador", value: playerId, inline: true },
          { name: "match", value: `\`${matchId}\``, inline: true },
          { name: "round", value: roundId.toString(), inline: true },
          { name: "proximo round", value: nextMatchCopy ? nextRound.toString() : "nenhum (ultimo round)", inline: true },
        )
        .setTimestamp();

      await this.sendLog(new EmbedBuilder()
        .setTitle("wo aplicado")
        .setColor(0x43b581)
        .setDescription(`por ${executor}`)
        .addFields(
          { name: "torneio", value: `\`${tournamentId}\``, inline: true },
          { name: "jogador", value: playerId, inline: true },
          { name: "round", value: roundId.toString(), inline: true },
        )
        .setTimestamp()
      );

      await this.safeEditReply(interaction, { embeds: [embed] }, "wo");
    } catch (error) {
      console.error("wo error:", error);
      await this.safeEditReply(
        interaction,
        { content: `falhou: ${error instanceof Error ? error.message : String(error)}` },
        "wo"
      );
    }
  }

  private static async handleResetRanking(interaction: any): Promise<void> {
    try {
      const deferred = await this.safeDefer(interaction, "resetranking");
      if (!deferred) return;

      const result = await BackboneUser.updateMany(
        { TournamentsWon: { $gt: 0 } },
        { $set: { TournamentsWon: 0 } }
      );

      const embed = new EmbedBuilder()
        .setTitle("ranking resetado")
        .setColor(0xf81616)
        .addFields(
          { name: "jogadores afetados", value: result.modifiedCount.toString(), inline: true },
        )
        .setTimestamp();

      const executor = interaction.user?.tag ?? interaction.user?.id ?? "unknown";
      await this.sendLog(new EmbedBuilder()
        .setTitle("ranking resetado")
        .setColor(0xf81616)
        .setDescription(`por ${executor}`)
        .addFields({ name: "jogadores afetados", value: result.modifiedCount.toString(), inline: true })
        .setTimestamp()
      );

      await this.safeEditReply(interaction, { embeds: [embed] }, "resetranking");
    } catch (error) {
      console.error("resetranking error:", error);
      await this.safeEditReply(
        interaction,
        { content: `falhou: ${error instanceof Error ? error.message : String(error)}` },
        "resetranking"
      );
    }
  }

  private static async handleAlterTorneio(interaction: any, mode: "add" | "remove"): Promise<void> {
    const label = mode === "add" ? "addtorneio" : "removertorneio";
    try {
      const deferred = await this.safeDefer(interaction, label);
      if (!deferred) return;

      const userId = interaction.options.getString("userid", true).trim();
      const quantidade = interaction.options.getInteger("quantidade", true);
      const user = await BackboneUser.findOne({ UserId: userId }).select("UserId Username TournamentsWon").lean();

      if (!user) {
        await this.safeEditReply(interaction, { content: "jogador nao encontrado" }, label);
        return;
      }

      const before = (user as any).TournamentsWon ?? 0;
      const inc = mode === "add" ? quantidade : -quantidade;
      const after = Math.max(0, before + inc);

      await BackboneUser.updateOne({ UserId: userId }, { $set: { TournamentsWon: after } });

      const embed = new EmbedBuilder()
        .setTitle(mode === "add" ? "torneios adicionados" : "torneios removidos")
        .setColor(mode === "add" ? 0x43b581 : 0xf81616)
        .addFields(
          { name: "jogador", value: `${(user as any).Username ?? userId} (\`${userId}\`)`, inline: false },
          { name: "antes", value: before.toString(), inline: true },
          { name: mode === "add" ? "+quantidade" : "-quantidade", value: quantidade.toString(), inline: true },
          { name: "depois", value: after.toString(), inline: true },
        )
        .setTimestamp();

      const executor = interaction.user?.tag ?? interaction.user?.id ?? "unknown";
      await this.sendLog(new EmbedBuilder()
        .setTitle(mode === "add" ? "torneios adicionados" : "torneios removidos")
        .setColor(mode === "add" ? 0x43b581 : 0xf81616)
        .setDescription(`por ${executor}`)
        .addFields(
          { name: "jogador", value: `\`${userId}\``, inline: true },
          { name: "antes", value: before.toString(), inline: true },
          { name: "depois", value: after.toString(), inline: true },
        )
        .setTimestamp()
      );

      await this.safeEditReply(interaction, { embeds: [embed] }, label);
    } catch (error) {
      console.error(`${label} error:`, error);
      await this.safeEditReply(
        interaction,
        { content: `falhou: ${error instanceof Error ? error.message : String(error)}` },
        label
      );
    }
  }
}
