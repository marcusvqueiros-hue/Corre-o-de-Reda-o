// Configuração do modo NUVEM (Vercel + Supabase). A chave abaixo é PÚBLICA por design (publishable key):
// todo acesso aos dados passa por funções RPC que validam o token do usuário. Vazio = modo servidor local.
export const CONFIG = {
  supabase: {
    url: 'https://mgmbwwjwxfzivjcscajt.supabase.co',
    key: 'sb_publishable_0RzOsHXfIA1AzeEaAek9qA_BQiGquvW',
  },
};
