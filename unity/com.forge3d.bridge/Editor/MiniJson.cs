using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Forge3D.Bridge
{
    /// <summary>Small JSON reader/writer: objects become Dictionary, arrays List, numbers double.</summary>
    public static class MiniJson
    {
        public static object Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new Dictionary<string, object>();
            var p = new Parser(json);
            var value = p.Value();
            p.SkipWs();
            if (!p.End) throw new FormatException("Trailing characters in JSON");
            return value;
        }

        public static string Write(object value)
        {
            var sb = new StringBuilder();
            WriteValue(sb, value);
            return sb.ToString();
        }

        static void WriteValue(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null: sb.Append("null"); break;
                case string s: WriteString(sb, s); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                case float f: sb.Append(Num(f)); break;
                case double d: sb.Append(Num(d)); break;
                case int or long or short or byte or uint or ulong:
                    sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture)); break;
                case IDictionary dict:
                    sb.Append('{');
                    var first = true;
                    foreach (DictionaryEntry e in dict)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, e.Key.ToString());
                        sb.Append(':');
                        WriteValue(sb, e.Value);
                    }
                    sb.Append('}');
                    break;
                case IEnumerable list:
                    sb.Append('[');
                    var firstItem = true;
                    foreach (var item in list)
                    {
                        if (!firstItem) sb.Append(',');
                        firstItem = false;
                        WriteValue(sb, item);
                    }
                    sb.Append(']');
                    break;
                default: WriteString(sb, v.ToString()); break;
            }
        }

        static string Num(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
            return Math.Round(d, 5).ToString("R", CultureInfo.InvariantCulture);
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        sealed class Parser
        {
            readonly string s;
            int i;

            public Parser(string json) { s = json; }
            public bool End => i >= s.Length;

            public void SkipWs()
            {
                while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
            }

            char Peek()
            {
                SkipWs();
                if (End) throw new FormatException("Unexpected end of JSON");
                return s[i];
            }

            public object Value()
            {
                var c = Peek();
                switch (c)
                {
                    case '{': return Obj();
                    case '[': return Arr();
                    case '"': return Str();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default: return Number();
                }
            }

            void Expect(string word)
            {
                if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0)
                    throw new FormatException($"Invalid token at {i}");
                i += word.Length;
            }

            Dictionary<string, object> Obj()
            {
                var d = new Dictionary<string, object>();
                i++;
                if (Peek() == '}') { i++; return d; }
                while (true)
                {
                    if (Peek() != '"') throw new FormatException($"Expected key at {i}");
                    var key = Str();
                    if (Peek() != ':') throw new FormatException($"Expected ':' at {i}");
                    i++;
                    d[key] = Value();
                    var c = Peek();
                    i++;
                    if (c == '}') return d;
                    if (c != ',') throw new FormatException($"Expected ',' at {i - 1}");
                }
            }

            List<object> Arr()
            {
                var l = new List<object>();
                i++;
                if (Peek() == ']') { i++; return l; }
                while (true)
                {
                    l.Add(Value());
                    var c = Peek();
                    i++;
                    if (c == ']') return l;
                    if (c != ',') throw new FormatException($"Expected ',' at {i - 1}");
                }
            }

            string Str()
            {
                var sb = new StringBuilder();
                i++;
                while (i < s.Length)
                {
                    var c = s[i++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    var e = s[i++];
                    switch (e)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                            i += 4;
                            break;
                        default: sb.Append(e); break;
                    }
                }
                throw new FormatException("Unterminated string");
            }

            double Number()
            {
                var start = i;
                while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
                if (start == i) throw new FormatException($"Unexpected character at {i}");
                return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }
        }
    }
}
