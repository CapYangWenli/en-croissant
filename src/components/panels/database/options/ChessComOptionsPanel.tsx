import { Alert, Button, Group, NumberInput, PasswordInput, Stack, Text } from "@mantine/core";
import { MonthPickerInput } from "@mantine/dates";
import { notifications } from "@mantine/notifications";
import { IconChevronRight, IconFlame, IconHourglassHigh, IconLogin, IconSend } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { commands } from "@/bindings";
import ToggleButtonGroup, {
  type ToggleButtonGroupOption,
} from "@/components/common/ToggleButtonGroup";
import { chessComOptionsAtom } from "@/state/atoms";
import type { ChessComTimeClass } from "@/utils/chess.com/explorer";
import { capitalize } from "@/utils/format";
import { unwrap } from "@/utils/unwrap";

const MIN_DATE = new Date(2015, 0, 1);

const ChessComOptionsPanel = () => {
  const { t } = useTranslation();
  const [options, setOptions] = useAtom(chessComOptionsAtom);
  const [loggingIn, setLoggingIn] = useState(false);

  async function loginToChessCom() {
    setLoggingIn(true);
    try {
      const result = await commands.chesscomLogin();
      if (result.status === "error") {
        if (!/cancelled/i.test(result.error)) {
          unwrap(result);
        }
        return;
      }
      setOptions((prev) => ({ ...prev, sessionCookie: result.data }));
      notifications.show({
        title: t("Board.Database.ChessCom"),
        message: t("Board.Database.ChessComLoggedIn"),
        color: "green",
      });
    } finally {
      setLoggingIn(false);
    }
  }

  const timeControls: ChessComTimeClass[] = ["bullet", "blitz", "rapid", "daily"];

  function mapTimeControl(speed: ChessComTimeClass): ToggleButtonGroupOption<ChessComTimeClass> {
    const name = `${speed.charAt(0).toUpperCase()}${speed.slice(1)}`;
    const icon = match(speed)
      .with("bullet", () => <IconChevronRight />)
      .with("blitz", () => <IconFlame />)
      .with("rapid", () => <IconHourglassHigh />)
      .with("daily", () => <IconSend />)
      .exhaustive();
    return {
      content: icon,
      name: t(`TimeControl.${capitalize(name)}`),
      value: speed,
      isToggled: options.timeClasses.some((s) => s === speed),
    };
  }

  function toggleTimeControl(speed: ChessComTimeClass) {
    const selected = [...options.timeClasses];
    const index = selected.indexOf(speed);
    if (index >= 0) {
      if (selected.length > 1) {
        selected.splice(index, 1);
      }
    } else {
      selected.push(speed);
    }
    setOptions({ ...options, timeClasses: selected });
  }

  return (
    <Stack justify="flex-start">
      <PasswordInput
        label={t("Board.Database.ChessComSession")}
        description={t("Board.Database.ChessComSessionHint")}
        placeholder="PHPSESSID=...; cf_clearance=..."
        value={options.sessionCookie ?? ""}
        onChange={(e) => setOptions({ ...options, sessionCookie: e.currentTarget.value })}
        autoComplete="off"
      />
      <Button
        leftSection={<IconLogin size="1.1rem" />}
        onClick={() => void loginToChessCom()}
        loading={loggingIn}
        variant="light"
      >
        {t("Board.Database.ChessComLogin")}
      </Button>
      <ToggleButtonGroup
        label={t("Board.Database.TimeControl")}
        options={timeControls.map(mapTimeControl)}
        toggleOption={toggleTimeControl}
        minButtonWidth="9ch"
        includeTooltips
      />
      <Group grow>
        <NumberInput
          label={t("Board.Database.MinRating")}
          value={options.minRating}
          min={0}
          max={4000}
          step={100}
          allowDecimal={false}
          onChange={(value) =>
            setOptions({
              ...options,
              minRating: typeof value === "number" ? value : undefined,
            })
          }
        />
        <NumberInput
          label={t("Board.Database.MaxRating")}
          value={options.maxRating}
          min={0}
          max={4000}
          step={100}
          allowDecimal={false}
          onChange={(value) =>
            setOptions({
              ...options,
              maxRating: typeof value === "number" ? value : undefined,
            })
          }
        />
      </Group>
      <Group grow>
        <MonthPickerInput
          label={t("Common.Since")}
          placeholder={t("Common.PickDate")}
          value={options.since}
          minDate={MIN_DATE}
          maxDate={new Date()}
          onChange={(value) =>
            setOptions({
              ...options,
              since: value ? new Date(value) : undefined,
            })
          }
          clearable
        />
        <MonthPickerInput
          label={t("Common.Until")}
          placeholder={t("Common.PickDate")}
          value={options.until}
          minDate={MIN_DATE}
          maxDate={new Date()}
          onChange={(value) =>
            setOptions({
              ...options,
              until: value ? new Date(value) : undefined,
            })
          }
          clearable
        />
      </Group>
      <Alert color="gray">
        <Text size="sm">{t("Board.Database.ChessComTranspositions")}</Text>
      </Alert>
    </Stack>
  );
};

export default ChessComOptionsPanel;
