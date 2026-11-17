<?php
declare(strict_types=1);

namespace Madovai\Live;

use Madovai\Rome;

/**
 * Port of ReminderDepartureStatus.swift: "what is the next departure" for the three
 * reminder sources, normalised to
 *   ['time'=>'HH:MM', 'delayMinutes'=>?int, 'isCancelled'=>bool, 'nextUsefulTime'=>?string].
 */
final class DepartureStatus
{
    /**
     * @param array<string,mixed> $reminder  Reminder JSON ({source:{type,…}, …})
     * @return array{time:string, delayMinutes:?int, isCancelled:bool, nextUsefulTime:?string}|null  null = failure / nothing upcoming
     */
    public static function forReminder(array $reminder, ?\DateTimeImmutable $now = null): ?array
    {
        try {
            $source = $reminder['source'] ?? null;
            if (!is_array($source)) {
                return null;
            }
            $now ??= Rome::now();
            switch ($source['type'] ?? null) {
                case 'cotralBus':
                    $result = CotralClient::transits((string) ($source['poleCode'] ?? ''));
                    return $result === null ? null : self::fromTransits($result['transits'], $now);
                case 'cotralTrain':
                    $direction = AstralRepository::departures((string) ($source['route'] ?? ''), (string) ($source['stationName'] ?? ''));
                    if ($direction === null) {
                        return null;
                    }
                    return self::fromAstral(AstralRepository::upcoming($direction['entries'], Rome::secondsSinceMidnight($now)));
                case 'atacStop':
                    $stopId = (string) ($source['stopId'] ?? '');
                    if (!CotralTime::isValidCode($stopId)) {
                        return null;
                    }
                    return self::fromAtac(AtacRealtime::upcomingArrivals($stopId, 2, $now->getTimestamp()));
                default:
                    return null;
            }
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * Cotral bus: next not-yet-passed runs, delay-aware (Transit.minutesFromNow / adjustedDisplayTime).
     *
     * @param list<array<string,mixed>> $transits
     */
    public static function fromTransits(array $transits, \DateTimeImmutable $now): ?array
    {
        $nowMinutes = (int) $now->format('G') * 60 + (int) $now->format('i');
        $items = [];
        foreach ($transits as $i => $t) {
            $reliable = CotralClient::isDelayReliable($t);
            $display = $t['tempoTransito'] !== '' ? $t['tempoTransito'] : $t['orarioPartenzaCorsa'];
            $adjusted = ($reliable && abs($t['ritardoSeconds']) >= 60)
                ? self::applyingDelay($display, $t['ritardoSeconds'])
                : $display;
            $minutes = self::minutesFromNow($adjusted, $nowMinutes);
            if ($minutes === null || $minutes < 0) {
                continue;
            }
            $items[] = [
                'minutes' => $minutes,
                'index' => $i,
                'time' => $adjusted,
                // intdiv truncates toward zero like Swift's `/`
                'delayMinutes' => $reliable ? max(0, intdiv($t['ritardoSeconds'], 60)) : null,
                'isCancelled' => strtoupper(trim((string) $t['soppressa'], " \t")) === 'Y',
            ];
        }
        usort($items, static fn($a, $b) => [$a['minutes'], $a['index']] <=> [$b['minutes'], $b['index']]);
        return self::combine($items);
    }

    /**
     * @param list<array<string,mixed>> $upcoming  AstralRepository::upcoming() result (sorted)
     */
    public static function fromAstral(array $upcoming): ?array
    {
        return self::combine(array_map(static fn($d) => [
            'time' => $d['time'],
            'delayMinutes' => $d['delayMinutes'] === null ? null : max(0, $d['delayMinutes']),
            'isCancelled' => $d['isCancelled'],
        ], $upcoming));
    }

    /**
     * @param list<array{ts:int, delaySeconds:?int, isCancelled:bool}> $arrivals  sorted soonest first
     */
    public static function fromAtac(array $arrivals): ?array
    {
        return self::combine(array_map(static fn($a) => [
            'time' => Rome::hhmm($a['ts']),
            'delayMinutes' => $a['delaySeconds'] === null ? null : max(0, intdiv($a['delaySeconds'], 60)),
            'isCancelled' => $a['isCancelled'],
        ], $arrivals));
    }

    /** @param list<array<string,mixed>> $entries */
    private static function combine(array $entries): ?array
    {
        if ($entries === []) {
            return null;
        }
        $first = $entries[0];
        return [
            'time' => $first['time'],
            'delayMinutes' => $first['delayMinutes'],
            'isCancelled' => $first['isCancelled'],
            'nextUsefulTime' => $first['isCancelled'] ? ($entries[1]['time'] ?? null) : null,
        ];
    }

    /** "HH:MM" + seconds, wrapped to a 24h clock face (double modulo handles negatives). */
    private static function applyingDelay(string $time, int $ritardoSeconds): string
    {
        if (preg_match('/^(\d+):(\d+)$/', $time, $m) !== 1) {
            return $time;
        }
        $total = (int) $m[1] * 3600 + (int) $m[2] * 60 + $ritardoSeconds;
        $wrapped = (($total % 86400) + 86400) % 86400;
        return sprintf('%02d:%02d', intdiv($wrapped, 3600), intdiv($wrapped % 3600, 60));
    }

    /** Transit.minutesFromNow(): single day wrap around ±12h. */
    private static function minutesFromNow(string $time, int $nowMinutes): ?int
    {
        if (preg_match('/^(\d+):(\d+)$/', $time, $m) !== 1) {
            return null;
        }
        $diff = (int) $m[1] * 60 + (int) $m[2] - $nowMinutes;
        if ($diff > 12 * 60) {
            $diff -= 24 * 60;
        }
        if ($diff < -12 * 60) {
            $diff += 24 * 60;
        }
        return $diff;
    }
}
