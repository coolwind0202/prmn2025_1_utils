// Require the necessary discord.js classes
import { ApplicationCommandType, CacheType, ChannelType, ChatInputCommandInteraction, Client, Collection, Events, GatewayIntentBits, GuildMember, GuildMemberRoleManager, Interaction, Message, MessageContextMenuCommandInteraction, MessageFlags, REST, Role, Routes, TextChannel, UserContextMenuCommandInteraction } from "discord.js";
import 'dotenv/config'
import { setTimeout } from "timers/promises";

const token = process.env.DISCORD_TOKEN;
if (token === undefined) {
    throw Error("DISCORD_TOKEN is unset");
}

const clientID = process.env.CLIENT_ID;
if (clientID === undefined) {
    throw Error("CLIENT_ID is unset");
}

const groupRoleNames = ["AI", "MR", "VR", "IR", "システム", "インフラ"];
const isGroupRole = (role: Role) => groupRoleNames.includes(role.name);
const isB2Role = (role: Role) => role.name == "b2";
const roleIsMatchedForAnswer = (role: Role, answer: string) => role.name == answer;

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// When the client is ready, run this code (only once).
// The distinction between `client: Client<boolean>` and `readyClient: Client<true>` is important for TypeScript developers.
// It makes some properties non-nullable.
client.once(Events.ClientReady, (readyClient: Client) => {
    console.log(`Ready! Logged in as ${readyClient.user?.tag ?? ""}`);
});

type Command = {
    metadata: {
        name: string,
        description: string,
        type: ApplicationCommandType.ChatInput
    },
    execute: (interaction: ChatInputCommandInteraction<CacheType>) => Promise<any>
} | {
    metadata: {
        name: string,
        type: ApplicationCommandType.Message
    };
    execute: (interaction: MessageContextMenuCommandInteraction<CacheType>) => Promise<any>
}

const planningGuideURL = "https://inexpensive-postbox-6ba.notion.site/1be1918dea5f804490c6d7bee1b1f78a#1be1918dea5f8018b8b4c4262dd26d4d";

const commands: Command[] = [
    {
        metadata: {
            name: "create_reviews",
            description: "B2ロールを持つメンバーに合わせて、振り返りスレッドを作成します。",
            type: ApplicationCommandType.ChatInput
        },
        async execute(interaction: ChatInputCommandInteraction<CacheType>) {
            // Navigation
            const guild = interaction.guild ?? undefined;
            const channel = interaction.channel ?? undefined;

            if (guild === undefined || channel === undefined)
                throw new Error("Failed to get where the interaction was sent on");

            if (channel.type != ChannelType.GuildText) {
                await interaction.reply({
                    content: "このコマンドはテキストチャンネルで実行してください。", flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (!channel.name.includes("振り返り")) {
                await interaction.reply({
                    content: "このコマンドは振り返りチャンネルで実行してください。", flags: MessageFlags.Ephemeral
                });
                return;
            }

            await guild.members.fetch();
            console.info("Channel members (cache)", channel.members.map(m => m.displayName));

            await interaction.reply({ content: "作成します。", flags: MessageFlags.Ephemeral });

            // Find b2 members
            const roles = await guild.roles.fetch();
            const b2Role = roles.find(isB2Role);

            if (b2Role === undefined)
                throw new Error("Failed to find b2 role");

            const isB2 = (member: GuildMember) => member.roles.cache.has(b2Role.id);
            const b2Members = channel.members.filter(isB2);

            // Create threads
            for (const b2Member of b2Members.values()) {
                const thread = await channel.threads.create({
                    name: b2Member.displayName,
                });

                await thread.send(`${b2Member}さん用の計画・振り返りチャンネルです。\nまずは[ガイド](${planningGuideURL})にしたがって計画を立ててみましょう！`);
                await setTimeout(200);
            }

            await interaction.followUp({ content: "作成が完了しました。", flags: MessageFlags.Ephemeral });
        }
    },
    {
        metadata: {
            name: "validate_role",
            description: "B2メンバーに、グループ用ロールの割り当てを忘れたり、2つ以上割り当てたりしていないか確認します。",
            type: ApplicationCommandType.ChatInput
        },
        async execute(interaction: ChatInputCommandInteraction<CacheType>) {
            const guild = interaction.guild;
            if (guild === null) {
                throw new Error("Failed to get where the interaction was sent on");
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            const members = await guild.members.fetch();
            await guild.roles.fetch();

            const b2Members = members.filter(member => member.roles.cache.find(isB2Role));

            const countGroupRoles = (member: GuildMember) =>
                member.roles.cache.reduce((acc, role) => acc + Number(isGroupRole(role)), 0)
            const membersHasTooManyRoles = b2Members.filter(member => countGroupRoles(member) >= 2);
            const membersHasNoRoles = b2Members.filter(member => countGroupRoles(member) == 0);

            const toMentions = (members: Collection<string, GuildMember>) =>
                Array.from(members.values()).join("\n")

            await interaction.editReply(
                `ロールが2つ以上付与されたユーザ\n
${toMentions(membersHasTooManyRoles)}\n
ロールが1つも付与されていないユーザ\n
${toMentions(membersHasNoRoles)}`
            );
        }
    },
    {
        metadata: {
            name: "add_role_from_poll",
            type: ApplicationCommandType.Message
        },
        async execute(interaction: MessageContextMenuCommandInteraction<CacheType>) {
            const guild = interaction.guild;
            if (guild === null) {
                throw new Error("Failed to get where the interaction was sent on");
            }

            const poll = interaction.targetMessage.poll;
            if (poll === null) {
                await interaction.reply("指定されたメッセージは投票を含んでいません。");
                return;
            }

            const members = await guild.members.fetch();
            const roles = await guild.roles.fetch();

            await interaction.reply({ content: "ロール付与を開始します。", flags: MessageFlags.Ephemeral });

            for (const answer of poll.answers.values()) {
                const text = answer.text ?? "";
                if (text.length == 0) continue;
                
                const role = roles.find(r => roleIsMatchedForAnswer(r, text));
                if (role === undefined) {
                    await interaction.followUp({ 
                        content: `選択肢「${text}」に対応するロールが見つかりませんでした。`,
                        flags: MessageFlags.Ephemeral
                    });
                    continue;
                }
                if (!isGroupRole(role)) {
                    await interaction.followUp({
                        content: `「${role.name}」はグループ用のロールではありません。`,
                        flags: MessageFlags.Ephemeral
                    });
                    continue;
                }

                const voters = await answer.fetchVoters();

                for (const voter of voters.values()) {
                    const member = members.get(voter.id);

                    if (member !== undefined) {
                        await member.roles.add(role);
                    }
                }

                await interaction.followUp({ content: `「${role.name}」の割り当てを行いました。`, flags: MessageFlags.Ephemeral });
                await setTimeout(200);
            }
            await interaction.followUp({ content: "すべての割り当てが完了しました。", flags: MessageFlags.Ephemeral });
        }
    }
]

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() && !interaction.isMessageContextMenuCommand()) {
        return;
    }

    const command = commands.find(command => command.metadata.name === interaction.commandName);
    if (command !== undefined) {
        console.info(`[Command] ${command.metadata.name} `);
        try {
            // @ts-ignore
            await command.execute(interaction);
        } catch (e) {
            console.error(e);
        }
    } else {
        await interaction.reply({ content: "コマンド処理が見つかりませんでした", flags: MessageFlags.Ephemeral });
    }
})

console.log("Register the application commands...");
const rest = new REST().setToken(token);
rest.put(Routes.applicationCommands(clientID), { body: commands.map(command => command.metadata) });

console.log("login...")
// Log in to Discord with your client's token
client.login(process.env.DISCORD_TOKEN);