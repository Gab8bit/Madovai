<?php
declare(strict_types=1);

namespace Madovai\Live;

/** Parsing of Cotral's tiny XML replies (port of XMLNode.swift's parse rules). */
final class CotralXml
{
    /**
     * Cotral sometimes answers with just a dangling closing tag (e.g. "</transiti>")
     * for an unknown/no-data query, or an empty body: both mean "no data" (null),
     * as does an unparseable document.
     */
    public static function parse(string $body): ?\SimpleXMLElement
    {
        // Swift decodes the body as strict UTF-8; be a little more forgiving
        // instead of silently dropping a whole pole over one stray Latin-1 byte.
        if (!mb_check_encoding($body, 'UTF-8')) {
            $body = mb_convert_encoding($body, 'UTF-8', 'ISO-8859-1');
        }
        $trimmed = trim($body, " \t\n\r\0\x0B");
        if ($trimmed === '') {
            return null;
        }
        if (preg_match('#^</[A-Za-z][\w:.-]*>$#', $trimmed) === 1) {
            return null;
        }
        $prev = libxml_use_internal_errors(true);
        try {
            $xml = simplexml_load_string($trimmed, \SimpleXMLElement::class, LIBXML_NONET | LIBXML_NOCDATA);
        } finally {
            libxml_clear_errors();
            libxml_use_internal_errors($prev);
        }
        return $xml === false ? null : $xml;
    }

    /** Trimmed text of the first child `$tag`, or '' (Cotral's fields are consistently non-optional strings). */
    public static function text(\SimpleXMLElement $node, string $tag): string
    {
        return isset($node->{$tag}) ? self::trimText((string) $node->{$tag}) : '';
    }

    public static function trimText(string $s): string
    {
        return trim($s, " \t\n\r\0\x0B");
    }
}
