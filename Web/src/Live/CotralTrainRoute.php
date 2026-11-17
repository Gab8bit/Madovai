<?php
declare(strict_types=1);

namespace Madovai\Live;

/** Port of CotralTrainRoute.swift: ASTRAL's `codicePercorso` values (one per direction of each rail line). */
final class CotralTrainRoute
{
    /** @var array<string, array{line:string, direction:string, destination:string}> */
    private const ROUTES = [
        'RL_CC-PSP' => ['line' => 'Metromare', 'direction' => 'Cristoforo Colombo → Porta San Paolo', 'destination' => 'Porta San Paolo'],
        'RL_PSP-CC' => ['line' => 'Metromare', 'direction' => 'Porta San Paolo → Cristoforo Colombo', 'destination' => 'Cristoforo Colombo'],
        'RN_RMMON' => ['line' => 'Roma-Viterbo Urbana', 'direction' => 'Flaminio → Montebello', 'destination' => 'Montebello'],
        'RN_MONRM' => ['line' => 'Roma-Viterbo Urbana', 'direction' => 'Montebello → Flaminio', 'destination' => 'Flaminio'],
        'RV_CATVIT' => ['line' => 'Roma-Viterbo Extraurbana', 'direction' => 'Catalano → Viterbo', 'destination' => 'Viterbo'],
        'RV_VITCAT' => ['line' => 'Roma-Viterbo Extraurbana', 'direction' => 'Viterbo → Catalano', 'destination' => 'Catalano'],
        'RV_MORCAT' => ['line' => 'Roma-Viterbo Extraurbana', 'direction' => 'Morlupo → Catalano', 'destination' => 'Catalano'],
        'RV_CATMOR' => ['line' => 'Roma-Viterbo Extraurbana', 'direction' => 'Catalano → Morlupo', 'destination' => 'Morlupo'],
    ];

    public static function isValid(string $code): bool
    {
        return isset(self::ROUTES[$code]);
    }

    /** @return list<string> */
    public static function all(): array
    {
        return array_keys(self::ROUTES);
    }

    public static function lineName(string $code): string
    {
        return self::ROUTES[$code]['line'];
    }

    public static function directionLabel(string $code): string
    {
        return self::ROUTES[$code]['direction'];
    }

    public static function destinationName(string $code): string
    {
        return self::ROUTES[$code]['destination'];
    }
}
