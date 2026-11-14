/** Erros genéricos de propósito: nunca incluem senha, chave ou conteúdo. */
export class CryptoFormatError extends Error {
  constructor(message = "Formato de dados inválido.") {
    super(message);
    this.name = "CryptoFormatError";
  }
}

/** Senha errada, chave errada, dado adulterado ou AAD divergente: indistinguíveis por design. */
export class DecryptionError extends Error {
  constructor(message = "Não foi possível abrir os dados: senha incorreta ou dados adulterados.") {
    super(message);
    this.name = "DecryptionError";
  }
}

export class KdfParamsError extends Error {
  constructor(message = "Parâmetros de derivação de chave fora dos limites aceitos.") {
    super(message);
    this.name = "KdfParamsError";
  }
}
