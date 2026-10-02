<?php
declare(strict_types=1);

namespace Madovai\Push;

/** Notification texts — a literal port of iOS `ReminderNotifier` (Italian). */
final class ReminderNotifier
{
    /** `CotralTrainRoute.directionLabel` */
    public const DIRECTION_LABELS = [
        'RL_CC-PSP' => 'Cristoforo Colombo → Porta San Paolo',
        'RL_PSP-CC' => 'Porta San Paolo → Cristoforo Colombo',
        'RN_RMMON' => 'Flaminio → Montebello',
        'RN_MONRM' => 'Montebello → Flaminio',
        'RV_CATVIT' => 'Catalano → Viterbo',
        'RV_VITCAT' => 'Viterbo → Catalano',
        'RV_MORCAT' => 'Morlupo → Catalano',
        'RV_CATMOR' => 'Catalano → Morlupo',
    ];

    public const URL = '/#/promemoria';

    /**
     * @param array<string,mixed> $reminder validated reminder
     * @param array{time:string,delayMinutes:?int,isCancelled:bool,nextUsefulTime:?string} $status
     * @return array{title:string,body:string,tag:string,url:string}
     */
    public static function payload(array $reminder, array $status): array
    {
        $source = (array) ($reminder['source'] ?? []);
        $isTrain = ($source['type'] ?? '') === 'cotralTrain';
        $vehicle = $isTrain ? 'treno' : 'bus';

        $target = 'per ' . ($reminder['stopName'] ?? '');
        if ($isTrain) {
            $target .= ', direzione ' . (self::DIRECTION_LABELS[$source['route'] ?? ''] ?? ($source['route'] ?? ''));
        }

        if (!empty($status['isCancelled'])) {
            $next = $status['nextUsefulTime'] ?? null;
            $fallback = $next !== null && $next !== ''
                ? " Prossimo utile: $next."
                : " Nessun'altra corsa in programma.";
            $body = "Il prossimo $vehicle $target è stato soppresso.$fallback";
        } else {
            $delay = $status['delayMinutes'] ?? null;
            if ($delay === null || $delay < 1) {
                $body = "Il prossimo $vehicle $target non fa ritardo.";
            } else {
                $body = "Il prossimo $vehicle $target è in ritardo di $delay minut" . ($delay === 1 ? 'o' : 'i') . '.';
            }
        }

        return [
            'title' => "Prossimo $vehicle alle " . $status['time'],
            'body' => $body,
            'tag' => (string) $reminder['id'],
            'url' => self::URL,
        ];
    }

    /** @return array{title:string,body:string,tag:string,url:string} */
    public static function testPayload(): array
    {
        return [
            'title' => 'Notifiche attive',
            'body' => 'I promemoria di Madovai ti avviseranno su questo dispositivo.',
            'tag' => 'madovai-test',
            'url' => self::URL,
        ];
    }

    /** @param array<string,string> $payload */
    public static function json(array $payload): string
    {
        return json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
